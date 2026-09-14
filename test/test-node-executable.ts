/** Return the host Node binary for subprocess fixtures used by Electron tests. */
export function testNodeExecutable(): string {
  const value = process.env.AI_1667_TEST_NODE_EXECUTABLE?.trim();
  return value === undefined || value.length === 0 ? process.execPath : value;
}
