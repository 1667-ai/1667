/** Error types shared by browser-safe story and settings codecs. */
export class StoryFormatError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StoryFormatError";
  }
}
