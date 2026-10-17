export namespace Constants {
  export const EAGLERCRAFT_SKIN_CHANNEL_NAME: string = "EAG|Skins-1.8";
  export const MAGIC_ENDING_SERVER_SKIN_DOWNLOAD_BUILTIN: number[] = [0x00, 0x00, 0x00];
  export const MAGIC_ENDING_CLIENT_UPLOAD_SKIN_BUILTIN: number[] = [0x00, 0x05, 0x01, 0x00, 0x00, 0x00];
  export const EAGLERCRAFT_SKIN_CUSTOM_LENGTH = 64 ** 2 * 4;

  export const JOIN_SERVER_PACKET = 0x01;
  export const PLAYER_LOOK_PACKET = 0x08;

  export const ICON_SQRT = 64;
  export const END_BUFFER_LENGTH = ICON_SQRT ** 8;
  export const IMAGE_DATA_PREPEND = "data:image/png;base64,";
}
