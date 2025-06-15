import { getBearerToken, validateJWT } from "../auth";
import { respondWithJSON } from "./json";
import { getVideo, updateVideo } from "../db/videos";
import type { ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, UserForbiddenError } from "./errors";
import path from "path";

const MAX_UPLOAD_SIZE = 10 << 20

export async function handlerUploadThumbnail(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  console.log("uploading thumbnail for video", videoId, "by user", userID);

  const formData = await req.formData()

  const file = formData.get("thumbnail")

  if (!(file instanceof File)) {
    throw new BadRequestError("Thumbnail file missing")
  }

  if (file.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("File too large")
  }

  if (!['image/jpeg', 'image/png'].includes(file.type)) {
    throw new BadRequestError("File type not supported")
  }

  const [_, extension] = file.type.split('/')

  const filePath = path.join(cfg.assetsRoot, `${videoId}.${extension}`)

  Bun.write(filePath, file)

  const url = `http://localhost:8091/${filePath}`
  
  const metadata = getVideo(cfg.db, videoId)

  if (metadata?.userID !== userID) {
    throw new UserForbiddenError("Forbidden")
  }

  updateVideo(cfg.db, {...metadata, thumbnailURL: url})

  return respondWithJSON(200, metadata);
}
