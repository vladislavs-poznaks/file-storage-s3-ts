import { respondWithJSON } from "./json";

import { type ApiConfig } from "../config";
import { S3Client, type BunRequest } from "bun";
import { BadRequestError, UserForbiddenError } from "./errors";
import { getBearerToken, validateJWT } from "../auth";
import { getVideo, updateVideo } from "../db/videos";
import path from "path";
import crypto from "crypto";

type aspectRatio = "portrait" | "landscape" | "other"

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

  const aspectRatio = await getVideoAspectRatio(tempPath)

  const processedTempPath = await processVideoForFastStart(tempPath)

  const key = crypto.randomBytes(32).toString('hex')

  const filename = `${aspectRatio}/${key}.${extension}`

  const s3file = S3Client.file(filename)
  s3file.write(Bun.file(processedTempPath))

  const url = `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${filename}`

  updateVideo(cfg.db, {...metadata, videoURL: url})

  await Promise.all([
    Bun.file(tempPath).delete(),
    Bun.file(processedTempPath).delete()
  ])

  return respondWithJSON(200, metadata);
}

const getVideoAspectRatio = async (filePath: string): Promise<aspectRatio> => {
  const process = Bun.spawn([
    'ffprobe',
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height',
    '-of',
    'json',
    filePath,
  ])

  const outputText = await new Response(process.stdout).text();
  const errorText = await new Response(process.stderr).text();

  const exitCode = await process.exited;

  if (exitCode !== 0) {
    throw new Error(`ffprobe error: ${errorText}`);
  }

  const output = JSON.parse(outputText)

  if (!output.streams || output.streams.length === 0) {
    throw new Error("No video streams found");
  }

  const {height, width} = output.streams[0]

  const aspectRatio = width / height;
  const landscapeRatio = 16 / 9;
  const portraitRatio = 9 / 16;
  const epsilon = 0.01;

  if (Math.abs(aspectRatio - landscapeRatio) < epsilon) {
      return "landscape";
  } 
  
  if (Math.abs(aspectRatio - portraitRatio) < epsilon) {
      return "portrait";
  }

  return "other"
}

const processVideoForFastStart = async (inputFilePath: string): Promise<string> => {
  const outputFilePath = `${inputFilePath}.processed`

  const process = Bun.spawn([
    'ffmpeg',
    '-i',
    inputFilePath,
    '-movflags',
    'faststart',
    '-map_metadata',
    '0',
    '-codec',
    'copy',
    '-f',
    'mp4',
    outputFilePath,
  ])

  const errorText = await new Response(process.stderr).text();
  const exitCode = await process.exited;

  if (exitCode !== 0) {
    throw new Error(`FFmpeg error: ${errorText}`);
  }

  return outputFilePath
}
