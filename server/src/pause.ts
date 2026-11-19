/** Wait `ms` milliseconds (the one timer-backed delay the server's async steps share). */
export function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
