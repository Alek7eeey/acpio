// @vitest-environment jsdom
// The background-task list the composer chip and the tasks page read: it is
// filled by the socket, so these tests drive the frames the server sends.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BackgroundJobDto } from "@acpio/shared";

const apiMock = vi.hoisted(() => ({
  backgroundJobs: vi.fn(),
  stopBackgroundJob: vi.fn(),
  forgetBackgroundJob: vi.fn(),
  clearFinishedBackgroundJobs: vi.fn(),
}));
vi.mock("./api", () => ({ api: apiMock }));

import { useAppStore } from "./store";

function job(over: Partial<BackgroundJobDto> = {}): BackgroundJobDto {
  return {
    id: "bg-1",
    sessionId: "s1",
    sessionTitle: "Chat",
    cwd: "C:/proj",
    label: "npm run build",
    script: "npm run build",
    pid: 4242,
    status: "running",
    exitCode: null,
    startedAt: 1_000,
    endedAt: null,
    logPath: "C:/data/bg-logs/chat-1/bg-1.log",
    outputBytes: 0,
    ...over,
  };
}

beforeEach(() => {
  useAppStore.setState({ bgJobs: [] });
  apiMock.backgroundJobs.mockReset();
  apiMock.stopBackgroundJob.mockReset();
});

describe("background jobs over the socket", () => {
  it("adds a job the moment the agent starts it", () => {
    useAppStore.getState().handleWsEvent({ type: "bg.updated", job: job() });
    expect(useAppStore.getState().bgJobs.map((row) => row.id)).toEqual(["bg-1"]);
  });

  it("replaces the row when the job settles instead of adding a second one", () => {
    useAppStore.getState().handleWsEvent({ type: "bg.updated", job: job() });
    useAppStore
      .getState()
      .handleWsEvent({ type: "bg.updated", job: job({ status: "exited", exitCode: 0, pid: null, endedAt: 9_000 }) });

    const rows = useAppStore.getState().bgJobs;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "exited", exitCode: 0 });
    // What the chip counts: nothing is running any more.
    expect(rows.filter((row) => row.status === "running")).toEqual([]);
  });

  it("drops the rows the server forgot", () => {
    useAppStore.getState().handleWsEvent({ type: "bg.updated", job: job() });
    useAppStore.getState().handleWsEvent({ type: "bg.updated", job: job({ id: "bg-2" }) });
    useAppStore.getState().handleWsEvent({ type: "bg.removed", jobIds: ["bg-1"] });
    expect(useAppStore.getState().bgJobs.map((row) => row.id)).toEqual(["bg-2"]);
  });

  it("loads the current list on demand", async () => {
    apiMock.backgroundJobs.mockResolvedValue([job({ id: "bg-9" })]);
    await useAppStore.getState().refreshBackgroundJobs();
    expect(useAppStore.getState().bgJobs.map((row) => row.id)).toEqual(["bg-9"]);
  });

  it("stops a job through the API and takes the row the server answers with", async () => {
    useAppStore.getState().handleWsEvent({ type: "bg.updated", job: job() });
    apiMock.stopBackgroundJob.mockResolvedValue({ job: job({ status: "killed", pid: null, endedAt: 5_000 }) });
    await useAppStore.getState().stopBackgroundJob("bg-1");
    expect(apiMock.stopBackgroundJob).toHaveBeenCalledWith("bg-1");
    expect(useAppStore.getState().bgJobs[0]!.status).toBe("killed");
  });
});
