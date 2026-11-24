// @vitest-environment jsdom
//
// A rebuild changes the chunk hashes and Vite empties `dist`, so a tab left open
// across one asks for a file that no longer exists under that name. React's
// `lazy` rejects, no `<Suspense>` catches it, and the tab ended on the crash card
// over a page the server has. A stale chunk must reload the tab instead — once,
// so a build that really is broken still names its file.
import { Component, Suspense, type ReactNode } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lazyPage } from "./lazyPage";

const FLAG = "acpio.pageChunkReload";

function staleChunk(): Promise<{ default: () => ReactNode }> {
  return Promise.reject(
    new Error(
      "Failed to fetch dynamically imported module: http://localhost:18741/assets/BoardPage-Dsb96Ipz.js",
    ),
  );
}

function Page() {
  return <p>board</p>;
}

class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? <p>card</p> : this.props.children;
  }
}

function show(component: () => ReactNode) {
  const Lazy = lazyPage(() => Promise.resolve({ default: component }));
  return render(
    <Boundary>
      <Suspense fallback={<p>loading</p>}>{<Lazy />}</Suspense>
    </Boundary>,
  );
}

// jsdom's `location.reload` cannot be spied on in place (unforgeable), but the
// `location` property itself can be swapped for a stand-in that records the call.
const reload = vi.fn();
const locationDescriptor = Object.getOwnPropertyDescriptor(window, "location");

beforeEach(() => {
  sessionStorage.clear();
  reload.mockClear();
  Object.defineProperty(window, "location", {
    value: { reload },
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  cleanup();
  if (locationDescriptor) Object.defineProperty(window, "location", locationDescriptor);
});

describe("lazyPage", () => {
  it("reloads the tab once for a chunk the server no longer has, keeping the app up", async () => {
    const Lazy = lazyPage(staleChunk);
    render(
      <Boundary>
        <Suspense fallback={<p>loading</p>}>
          <Lazy />
        </Suspense>
      </Boundary>,
    );

    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    // The reload ends the document: neither the card nor a settled page appears.
    expect(screen.queryByText("card")).toBeNull();
    expect(screen.getByText("loading")).toBeTruthy();
    expect(sessionStorage.getItem(FLAG)).toBe("1");
  });

  it("shows the card when a stale chunk repeats: the build itself is broken", async () => {
    sessionStorage.setItem(FLAG, "1");
    const Lazy = lazyPage(staleChunk);
    render(
      <Boundary>
        <Suspense fallback={<p>loading</p>}>
          <Lazy />
        </Suspense>
      </Boundary>,
    );

    expect(await screen.findByText("card")).toBeTruthy();
    expect(reload).not.toHaveBeenCalled();
  });

  it("reloads again for a rebuild that happens after a successful page", async () => {
    sessionStorage.setItem(FLAG, "1");
    show(Page);
    expect(await screen.findByText("board")).toBeTruthy();
    expect(sessionStorage.getItem(FLAG)).toBeNull();

    const Lazy = lazyPage(staleChunk);
    render(
      <Boundary>
        <Suspense fallback={<p>loading</p>}>
          <Lazy />
        </Suspense>
      </Boundary>,
    );
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("card")).toBeNull();
  });

  it("leaves a page that throws on its own to the boundary", async () => {
    const Lazy = lazyPage(() => Promise.reject(new Error("Unexpected token '<'")));
    render(
      <Boundary>
        <Suspense fallback={<p>loading</p>}>
          <Lazy />
        </Suspense>
      </Boundary>,
    );

    expect(await screen.findByText("card")).toBeTruthy();
    expect(reload).not.toHaveBeenCalled();
  });
});
