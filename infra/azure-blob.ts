import { BlobServiceClient } from "@azure/storage-blob";
import { config } from "../src/config.js";

let _client: BlobServiceClient | null = null;

function getClient(): BlobServiceClient {
  if (!_client) {
    _client = BlobServiceClient.fromConnectionString(config.AZURE_STORAGE_CONNECTION_STRING);
  }
  return _client;
}

export async function uploadToBlob(
  blobName: string,
  data: Buffer | Uint8Array,
  contentType = "application/octet-stream"
): Promise<string> {
  const client = getClient();
  const containerClient = client.getContainerClient(config.AZURE_STORAGE_CONTAINER);

  // Create container if it doesn't exist
  await containerClient.createIfNotExists({ access: "blob" });

  const blobClient = containerClient.getBlockBlobClient(blobName);
  await blobClient.upload(data, data.length, {
    blobHTTPHeaders: { blobContentType: contentType },
  });

  return blobClient.url;
}

export async function downloadFromBlob(blobName: string): Promise<Buffer> {
  const client = getClient();
  const containerClient = client.getContainerClient(config.AZURE_STORAGE_CONTAINER);
  const blobClient = containerClient.getBlobClient(blobName);
  const response = await blobClient.download();
  const chunks: Buffer[] = [];
  for await (const chunk of response.readableStreamBody as AsyncIterable<Buffer>) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function listBlobs(prefix: string): Promise<string[]> {
  const client = getClient();
  const containerClient = client.getContainerClient(config.AZURE_STORAGE_CONTAINER);
  const names: string[] = [];
  for await (const blob of containerClient.listBlobsFlat({ prefix })) {
    names.push(blob.name);
  }
  return names;
}
