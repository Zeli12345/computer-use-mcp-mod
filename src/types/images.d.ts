declare module 'jpeg-js' {
  const jpeg: {
    decode(data: Buffer | Uint8Array, options?: Record<string, unknown>): {
      data: Buffer
      width: number
      height: number
    }
    encode(
      image: { data: Buffer | Uint8Array; width: number; height: number },
      quality?: number,
    ): { data: Buffer }
  }
  export default jpeg
}

declare module 'pngjs' {
  export class PNG {
    data: Buffer
    width: number
    height: number
    static sync: {
      read(buffer: Buffer | Uint8Array): PNG
      write(png: PNG, options?: Record<string, unknown>): Buffer
    }
  }
}
