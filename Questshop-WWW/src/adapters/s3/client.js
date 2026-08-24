import { S3Client } from '@aws-sdk/client-s3';

export function createS3Client(env) {
  return new S3Client({ endpoint: env.S3_ENDPOINT, region: env.S3_REGION,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY } });
}
