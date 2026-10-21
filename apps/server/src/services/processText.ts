/**
 * Decoder for a child process's output stream.
 *
 * Windows console tools still print in the OEM code page — CP866 on a Russian
 * system, which is what MSBuild, PowerShell errors and every `.cmd` shim write.
 * Read as UTF-8 those bytes become mojibake (`��㬥��`), and the reader who has to
 * act on the message is left guessing at the one line that explained the
 * failure.
 *
 * A stream is UTF-8 until a chunk proves otherwise: the first chunk that decodes
 * to replacement characters fixes the code page for the whole stream. Until that
 * proof arrives an incomplete multi-byte character stays pending
 * (`stream: true`), so a UTF-8 character split across two chunks is not mistaken
 * for CP866 — the naive read mis-decoded exactly that.
 */
export class ProcessTextDecoder {
  private utf8 = new TextDecoder("utf8");
  /** Set once the stream showed OEM bytes; the stream keeps that code page. */
  private oem: TextDecoder | null = null;

  decode(chunk: Buffer): string {
    if (process.platform !== "win32") return chunk.toString("utf8");
    if (this.oem) return this.oem.decode(chunk);
    const text = this.utf8.decode(chunk, { stream: true });
    if (!text.includes("\uFFFD")) return text;
    this.oem = new TextDecoder("ibm866");
    return this.oem.decode(chunk);
  }
}
