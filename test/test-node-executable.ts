/** Return the Node binary for subprocess fixtures. */
export function testNodeExecutable(): string {
  const value = process.env.AI_1667_TEST_NODE_EXECUTABLE?.trim();
  return value === undefined || value.length === 0 ? process.execPath : value;
}
