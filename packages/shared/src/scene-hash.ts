/** SHA-256 of the bytes as lowercase hex. Runs in the browser and in the Worker. */
export async function sha256Hex(
  bytes: ArrayBuffer | ArrayBufferView<ArrayBuffer>,
): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
