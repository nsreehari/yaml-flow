import type { KindValueRef } from '../common/storage-interface.js';
import type { AsyncBlobStorage } from './storage-async-interface.js';

export interface AzureBlobItemLike {
  name: string;
  properties?: {
    contentLength?: number;
    lastModified?: Date;
    contentType?: string;
  };
}

export interface AzureBlobClientLike {
  downloadToBuffer(): Promise<Uint8Array>;
  exists(): Promise<boolean>;
  deleteIfExists(): Promise<unknown>;
  getProperties(): Promise<{
    contentLength?: number;
    lastModified?: Date;
    contentType?: string;
  }>;
}

export interface AzureBlockBlobClientLike {
  upload(data: string | Uint8Array, length: number, options?: { blobHTTPHeaders?: { blobContentType?: string } }): Promise<unknown>;
}

export interface AzureBlobContainerClientLike {
  getBlobClient(key: string): AzureBlobClientLike;
  getBlockBlobClient(key: string): AzureBlockBlobClientLike;
  listBlobsFlat(options?: { prefix?: string }): AsyncIterable<AzureBlobItemLike>;
}

export interface AzureBlobStorageOptions {
  defaultContentType?: string;
  keyRef?: (key: string) => KindValueRef;
}

function decodeUtf8(content: Uint8Array): string {
  return new TextDecoder().decode(content);
}

export function createAzureBlobStorage(
  containerClient: AzureBlobContainerClientLike,
  options: AzureBlobStorageOptions = {},
): AsyncBlobStorage {
  return {
    async read(key: string): Promise<string | null> {
      if (!(await containerClient.getBlobClient(key).exists())) return null;
      const bytes = await containerClient.getBlobClient(key).downloadToBuffer();
      return decodeUtf8(bytes);
    },

    async write(key: string, content: string): Promise<void> {
      await containerClient.getBlockBlobClient(key).upload(content, new TextEncoder().encode(content).byteLength, {
        blobHTTPHeaders: { blobContentType: options.defaultContentType ?? 'application/json; charset=utf-8' },
      });
    },

    exists(key: string): Promise<boolean> {
      return containerClient.getBlobClient(key).exists();
    },

    async remove(key: string): Promise<void> {
      await containerClient.getBlobClient(key).deleteIfExists();
    },

    async readBytes(key: string): Promise<Uint8Array | null> {
      if (!(await containerClient.getBlobClient(key).exists())) return null;
      return await containerClient.getBlobClient(key).downloadToBuffer();
    },

    async writeBytes(key: string, content: Uint8Array): Promise<void> {
      await containerClient.getBlockBlobClient(key).upload(content, content.byteLength, {
        blobHTTPHeaders: { blobContentType: options.defaultContentType ?? 'application/octet-stream' },
      });
    },

    async listKeys(prefix = ''): Promise<string[]> {
      const keys: string[] = [];
      for await (const item of containerClient.listBlobsFlat({ prefix })) keys.push(item.name);
      return keys.sort();
    },

    async stat(key: string) {
      if (!(await containerClient.getBlobClient(key).exists())) return null;
      const props = await containerClient.getBlobClient(key).getProperties();
      return {
        key,
        size: Number(props.contentLength ?? 0),
        updatedAt: props.lastModified?.toISOString(),
        contentType: props.contentType,
      };
    },

    keyRef(key: string): KindValueRef {
      return options.keyRef?.(key) ?? { kind: 'azure-blob-key', value: key };
    },

    async renameKey(from: string, to: string): Promise<boolean> {
      const fromBlob = containerClient.getBlobClient(from);
      if (!(await fromBlob.exists())) return false;
      const [bytes, props] = await Promise.all([
        fromBlob.downloadToBuffer(),
        fromBlob.getProperties(),
      ]);
      await containerClient.getBlockBlobClient(to).upload(bytes, bytes.byteLength, {
        blobHTTPHeaders: {
          blobContentType: props.contentType ?? options.defaultContentType ?? 'application/octet-stream',
        },
      });
      await fromBlob.deleteIfExists();
      return true;
    },
  };
}