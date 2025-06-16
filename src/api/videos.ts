import { respondWithJSON } from "./json";

import { type ApiConfig } from "../config";
import { S3Client, type BunRequest } from "bun";
import { BadRequestError, UserForbiddenError } from "./errors";
import { getBearerToken, validateJWT } from "../auth";
import { getVideo, updateVideo } from "../db/videos";
import path from "path";
import crypto from "crypto";

const MAX_UPLOAD_SIZE = 1 << 30

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  console.log("uploading video for video", videoId, "by user", userID);

  const metadata = getVideo(cfg.db, videoId)

  if (metadata?.userID !== userID) {
    throw new UserForbiddenError("Forbidden")
  }

  const formData = await req.formData()

  const file = formData.get("video")

  if (!(file instanceof File)) {
    throw new BadRequestError("Video file missing")
  }

  if (file.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("File too large")
  }

  if (!['video/mp4'].includes(file.type)) {
    throw new BadRequestError("File type not supported")
  }

  const [_, extension] = file.type.split('/')

  const tempPath = path.join(cfg.tempRoot, `${videoId}.${extension}`)

  await Bun.write(tempPath, file)

  const key = crypto.randomBytes(32).toString('hex')

  const filename = `${key}.${extension}`

  console.log('key', filename)

  const s3file = S3Client.file(filename)
  s3file.write(Bun.file(tempPath))

  const url = `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${filename}`

  updateVideo(cfg.db, {...metadata, videoURL: url})

  await Bun.file(tempPath).delete()

  return respondWithJSON(200, metadata);
}
