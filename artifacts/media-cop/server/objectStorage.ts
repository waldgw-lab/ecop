import { Storage, File } from "@google-cloud/storage";
import { Response } from "express";
import { randomUUID } from "crypto";
import {
  ObjectAclPolicy,
  ObjectPermission,
  canAccessObject,
  getObjectAclPolicy,
  setObjectAclPolicy,
} from "./objectAcl";

const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";

// The object storage client is used to interact with the object storage service.
export const objectStorageClient = new Storage({
  credentials: {
    audience: "replit",
    subject_token_type: "access_token",
    token_url: `${REPLIT_SIDECAR_ENDPOINT}/token`,
    type: "external_account",
    credential_source: {
      url: `${REPLIT_SIDECAR_ENDPOINT}/credential`,
      format: {
        type: "json",
        subject_token_field_name: "access_token",
      },
    },
    universe_domain: "googleapis.com",
  },
  projectId: "",
});

export class ObjectNotFoundError extends Error {
  constructor() {
    super("Object not found");
    this.name = "ObjectNotFoundError";
    Object.setPrototypeOf(this, ObjectNotFoundError.prototype);
  }
}

// The object storage service is used to interact with the object storage service.
const CURRENT_BUCKET_ID =
  process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID ||
  "replit-objstore-73e6fd8e-547b-47cb-94f3-e2f737c70f3f";
const LEGACY_BUCKET_IDS = [
  "replit-objstore-73e6fd8e-547b-47cb-94f3-e2f737c70f3f",
  "replit-objstore-8a7cd9ba-b5ee-4ea1-87e2-6a2b963405dd",
  "replit-objstore-0889b600-9ed6-4abc-95ca-04efbd6b353d",
];

export class ObjectStorageService {
  constructor() {}

  private getWriteBucketId(): string {
    return CURRENT_BUCKET_ID;
  }

  getPublicObjectSearchPaths(): Array<string> {
    return [
      `/${CURRENT_BUCKET_ID}/public`,
      ...LEGACY_BUCKET_IDS.map(id => `/${id}/public`),
    ];
  }

  getPrivateObjectDir(): string {
    return `/${CURRENT_BUCKET_ID}/.private`;
  }

  private getAllPrivateObjectDirs(): string[] {
    return [
      `/${CURRENT_BUCKET_ID}/.private`,
      ...LEGACY_BUCKET_IDS.map(id => `/${id}/.private`),
    ];
  }

  // Search for a public object from the search paths.
  async searchPublicObject(filePath: string): Promise<File | null> {
    for (const searchPath of this.getPublicObjectSearchPaths()) {
      const fullPath = `${searchPath}/${filePath}`;

      const { bucketName, objectName } = parseObjectPath(fullPath);
      const bucket = objectStorageClient.bucket(bucketName);
      const file = bucket.file(objectName);

      const [exists] = await file.exists();
      if (exists) {
        return file;
      }
    }

    return null;
  }

  // Downloads an object to the response.
  async downloadObject(file: File, res: Response, cacheTtlSec: number = 3600) {
    try {
      const [metadata] = await file.getMetadata();
      const aclPolicy = await getObjectAclPolicy(file);
      const isPublic = aclPolicy?.visibility === "public";
      
      res.set({
        "Content-Type": metadata.contentType || "application/octet-stream",
        "Content-Length": metadata.size,
        "Cache-Control": `${
          isPublic ? "public" : "private"
        }, max-age=${cacheTtlSec}`,
      });

      const stream = file.createReadStream();

      stream.on("error", (err: Error) => {
        console.error("Stream error:", err);
        if (!res.headersSent) {
          res.status(500).json({ error: "Error streaming file" });
        }
      });

      stream.pipe(res);
    } catch (error) {
      console.error("Error downloading file:", error);
      if (!res.headersSent) {
        res.status(500).json({ error: "Error downloading file" });
      }
    }
  }

  // Gets the upload URL for an object entity.
  async getObjectEntityUploadURL(): Promise<string> {
    const privateObjectDir = this.getPrivateObjectDir();
    if (!privateObjectDir) {
      throw new Error(
        "PRIVATE_OBJECT_DIR not set. Create a bucket in 'Object Storage' " +
          "tool and set PRIVATE_OBJECT_DIR env var."
      );
    }

    const objectId = randomUUID();
    const fullPath = `${privateObjectDir}/uploads/${objectId}`;

    const { bucketName, objectName } = parseObjectPath(fullPath);

    return signObjectURL({
      bucketName,
      objectName,
      method: "PUT",
      ttlSec: 900,
    });
  }

  // Uploads an outlet logo to the PUBLIC folder and returns an app-relative URL
  // (served by GET /api/public-objects/:filePath). Public so the Curated view
  // can render it without auth, matching how bundled logos render.
  async uploadOutletLogo(
    buffer: Buffer,
    contentType: string,
    ext: string,
  ): Promise<string> {
    const publicDir = `/${this.getWriteBucketId()}/public`;
    const objectId = randomUUID();
    const safeExt = (ext || "png").replace(/[^a-z0-9]/gi, "").toLowerCase() || "png";
    const relPath = `outlet-logos/${objectId}.${safeExt}`;
    const fullPath = `${publicDir}/${relPath}`;

    const { bucketName, objectName } = parseObjectPath(fullPath);
    const bucket = objectStorageClient.bucket(bucketName);
    const file = bucket.file(objectName);
    await file.save(buffer, {
      metadata: { contentType: contentType || "application/octet-stream" },
    });

    return `/api/public-objects/${relPath}`;
  }

  async getObjectEntityFile(objectPath: string): Promise<File> {
    if (!objectPath.startsWith("/objects/")) {
      throw new ObjectNotFoundError();
    }

    const parts = objectPath.slice(1).split("/");
    if (parts.length < 2) {
      throw new ObjectNotFoundError();
    }

    const entityId = parts.slice(1).join("/");

    const dirsToSearch = this.getAllPrivateObjectDirs();
    for (const dir of dirsToSearch) {
      let entityDir = dir;
      if (!entityDir.endsWith("/")) {
        entityDir = `${entityDir}/`;
      }
      const objectEntityPath = `${entityDir}${entityId}`;
      const { bucketName, objectName } = parseObjectPath(objectEntityPath);
      const bucket = objectStorageClient.bucket(bucketName);
      const objectFile = bucket.file(objectName);
      try {
        const [exists] = await objectFile.exists();
        if (exists) {
          return objectFile;
        }
      } catch (e) {
        // Continue to next bucket
      }
    }
    throw new ObjectNotFoundError();
  }

  normalizeObjectEntityPath(
    rawPath: string,
  ): string {
    if (!rawPath.startsWith("https://storage.googleapis.com/")) {
      return rawPath;
    }
  
    const url = new URL(rawPath);
    const rawObjectPath = url.pathname;
  
    let objectEntityDir = this.getPrivateObjectDir();
    if (!objectEntityDir.endsWith("/")) {
      objectEntityDir = `${objectEntityDir}/`;
    }
  
    if (!rawObjectPath.startsWith(objectEntityDir)) {
      return rawObjectPath;
    }

    const entityId = rawObjectPath.slice(objectEntityDir.length);
    return `/objects/${entityId}`;
  }

  async trySetObjectEntityAclPolicy(
    rawPath: string,
    aclPolicy: ObjectAclPolicy
  ): Promise<string> {
    const normalizedPath = this.normalizeObjectEntityPath(rawPath);
    if (!normalizedPath.startsWith("/")) {
      return normalizedPath;
    }

    const objectFile = await this.getObjectEntityFile(normalizedPath);
    await setObjectAclPolicy(objectFile, aclPolicy);
    return normalizedPath;
  }

  async canAccessObjectEntity({
    userId,
    objectFile,
    requestedPermission,
  }: {
    userId?: string;
    objectFile: File;
    requestedPermission?: ObjectPermission;
  }): Promise<boolean> {
    return canAccessObject({
      userId,
      objectFile,
      requestedPermission: requestedPermission ?? ObjectPermission.READ,
    });
  }

  // Upload a chat image to object storage
  async uploadChatImage(buffer: Buffer, originalName: string, contentType: string): Promise<string> {
    const privateObjectDir = this.getPrivateObjectDir();
    if (!privateObjectDir) {
      throw new Error(
        "PRIVATE_OBJECT_DIR not set. Create a bucket in 'Object Storage' " +
          "tool and set PRIVATE_OBJECT_DIR env var."
      );
    }

    const sanitizedOriginalName = originalName.replace(/[^a-zA-Z0-9.-]/g, '_');
    const filename = `${Date.now()}-${sanitizedOriginalName}`;
    const fullPath = `${privateObjectDir}/chat-images/${filename}`;

    const { bucketName, objectName } = parseObjectPath(fullPath);

    const bucket = objectStorageClient.bucket(bucketName);
    const file = bucket.file(objectName);

    console.log(`[Upload] Uploading chat image: bucket=${bucketName}, object=${objectName}, size=${buffer.length}`);
    
    try {
      await file.save(buffer, {
        contentType: contentType,
        metadata: { contentType: contentType },
      });
      console.log(`[Upload] Chat image uploaded successfully: ${filename}`);
    } catch (error: any) {
      console.error(`[Upload] Error uploading chat image: bucket=${bucketName}, object=${objectName}, error=${error?.message || error}`);
      throw error;
    }

    return `/objects/chat-images/${filename}`;
  }

  async uploadStreamImage(buffer: Buffer, originalName: string, contentType: string): Promise<string> {
    const privateObjectDir = this.getPrivateObjectDir();
    if (!privateObjectDir) {
      throw new Error(
        "PRIVATE_OBJECT_DIR not set. Create a bucket in 'Object Storage' " +
          "tool and set PRIVATE_OBJECT_DIR env var."
      );
    }

    const sanitizedOriginalName = originalName.replace(/[^a-zA-Z0-9.-]/g, '_');
    const filename = `${Date.now()}-${sanitizedOriginalName}`;
    const fullPath = `${privateObjectDir}/stream-images/${filename}`;

    const { bucketName, objectName } = parseObjectPath(fullPath);

    const bucket = objectStorageClient.bucket(bucketName);
    const file = bucket.file(objectName);

    console.log(`[Upload] Uploading stream image: bucket=${bucketName}, object=${objectName}, size=${buffer.length}`);

    try {
      await file.save(buffer, {
        contentType: contentType,
        metadata: { contentType: contentType },
      });
      console.log(`[Upload] Stream image uploaded successfully: ${filename}`);
    } catch (error: any) {
      console.error(`[Upload] Error uploading stream image: bucket=${bucketName}, object=${objectName}, error=${error?.message || error}`);
      throw error;
    }

    return `/objects/stream-images/${filename}`;
  }

  async uploadWarScreenshot(buffer: Buffer, originalName: string, contentType: string): Promise<string> {
    const privateObjectDir = this.getPrivateObjectDir();
    if (!privateObjectDir) {
      throw new Error(
        "PRIVATE_OBJECT_DIR not set. Create a bucket in 'Object Storage' " +
          "tool and set PRIVATE_OBJECT_DIR env var."
      );
    }

    const sanitizedOriginalName = originalName.replace(/[^a-zA-Z0-9.-]/g, '_');
    const filename = `${Date.now()}-${sanitizedOriginalName}`;
    const fullPath = `${privateObjectDir}/war-screenshots/${filename}`;

    const { bucketName, objectName } = parseObjectPath(fullPath);

    const bucket = objectStorageClient.bucket(bucketName);
    const file = bucket.file(objectName);

    console.log(`[Upload] Uploading war screenshot: bucket=${bucketName}, object=${objectName}, size=${buffer.length}`);

    try {
      await file.save(buffer, {
        contentType: contentType,
        metadata: { contentType: contentType },
      });
      console.log(`[Upload] War screenshot uploaded successfully: ${filename}`);
    } catch (error: any) {
      console.error(`[Upload] Error uploading war screenshot: bucket=${bucketName}, object=${objectName}, error=${error?.message || error}`);
      throw error;
    }

    return `/objects/war-screenshots/${filename}`;
  }

  async uploadDailyNewsScrub(buffer: Buffer, originalName: string): Promise<string> {
    const privateObjectDir = this.getPrivateObjectDir();
    if (!privateObjectDir) {
      throw new Error(
        "PRIVATE_OBJECT_DIR not set. Create a bucket in 'Object Storage' " +
          "tool and set PRIVATE_OBJECT_DIR env var."
      );
    }

    const sanitizedOriginalName = originalName.replace(/[^a-zA-Z0-9.-]/g, '_');
    const filename = `${Date.now()}-${sanitizedOriginalName}`;
    const fullPath = `${privateObjectDir}/daily-news-scrubs/${filename}`;

    const { bucketName, objectName } = parseObjectPath(fullPath);

    const bucket = objectStorageClient.bucket(bucketName);
    const file = bucket.file(objectName);

    console.log(`[Upload] Uploading daily news scrub: bucket=${bucketName}, object=${objectName}, size=${buffer.length}`);

    try {
      await file.save(buffer, {
        contentType: 'application/pdf',
        metadata: { contentType: 'application/pdf' },
      });
      console.log(`[Upload] Daily news scrub uploaded successfully: ${filename}`);
    } catch (error: any) {
      console.error(`[Upload] Error uploading daily news scrub: bucket=${bucketName}, object=${objectName}, error=${error?.message || error}`);
      throw error;
    }

    return `/objects/daily-news-scrubs/${filename}`;
  }

  async uploadFlightTrackingImage(buffer: Buffer, originalName: string, contentType: string): Promise<string> {
    const privateObjectDir = this.getPrivateObjectDir();
    if (!privateObjectDir) {
      throw new Error(
        "PRIVATE_OBJECT_DIR not set. Create a bucket in 'Object Storage' " +
          "tool and set PRIVATE_OBJECT_DIR env var."
      );
    }

    const sanitizedOriginalName = originalName.replace(/[^a-zA-Z0-9.-]/g, '_');
    const filename = `${Date.now()}-${sanitizedOriginalName}`;
    const fullPath = `${privateObjectDir}/flight-tracking/${filename}`;

    const { bucketName, objectName } = parseObjectPath(fullPath);

    const bucket = objectStorageClient.bucket(bucketName);
    const file = bucket.file(objectName);

    try {
      await file.save(buffer, {
        contentType: contentType,
        metadata: { contentType: contentType },
      });
      console.log(`[Upload] Flight tracking image uploaded successfully: ${filename}`);
    } catch (error: any) {
      console.error(`[Upload] Error uploading flight tracking image: ${error?.message || error}`);
      throw error;
    }

    return `/objects/flight-tracking/${filename}`;
  }

  // Cleanup support (Task #765): list every object under `.private/<prefix>`
  // across the current + legacy buckets so an orphan sweep can compare the stored
  // files against the set of paths still referenced in the database. Returns the
  // File handle (so the caller can delete it), the app-relative entity id
  // (`<prefix><filename>`, matching the value stored as `/objects/<entityId>`),
  // and the creation time in ms (0 when unknown — the sweep treats unknown age as
  // "too young to delete" for safety). Read-only; performs no deletions itself.
  async listPrivateObjectsByPrefix(
    prefix: string,
  ): Promise<Array<{ file: File; entityId: string; timeCreatedMs: number }>> {
    const results: Array<{ file: File; entityId: string; timeCreatedMs: number }> = [];
    for (const dir of this.getAllPrivateObjectDirs()) {
      // dir === `/<bucket>/.private`; list objects under `.private/<prefix>`.
      const { bucketName, objectName } = parseObjectPath(`${dir}/${prefix}`);
      const bucket = objectStorageClient.bucket(bucketName);
      let files: File[];
      try {
        [files] = await bucket.getFiles({ prefix: objectName });
      } catch (e) {
        // A legacy bucket may be gone / inaccessible — skip it rather than fail
        // the whole sweep.
        continue;
      }
      for (const file of files) {
        const idx = file.name.indexOf(".private/");
        const entityId = idx >= 0 ? file.name.slice(idx + ".private/".length) : file.name;
        const rawTc = (file.metadata as any)?.timeCreated;
        const tc = rawTc ? Date.parse(rawTc) : NaN;
        results.push({ file, entityId, timeCreatedMs: Number.isFinite(tc) ? tc : 0 });
      }
    }
    return results;
  }

  // Upload a PDF file to object storage
  async uploadPDF(buffer: Buffer, originalName: string): Promise<string> {
    const privateObjectDir = this.getPrivateObjectDir();
    if (!privateObjectDir) {
      throw new Error(
        "PRIVATE_OBJECT_DIR not set. Create a bucket in 'Object Storage' " +
          "tool and set PRIVATE_OBJECT_DIR env var."
      );
    }

    const sanitizedOriginalName = originalName.replace(/[^a-zA-Z0-9.-]/g, '_');
    const filename = `${Date.now()}-${sanitizedOriginalName}`;
    const fullPath = `${privateObjectDir}/pdfs/${filename}`;

    const { bucketName, objectName } = parseObjectPath(fullPath);

    const bucket = objectStorageClient.bucket(bucketName);
    const file = bucket.file(objectName);

    console.log(`[Upload] Uploading PDF: bucket=${bucketName}, object=${objectName}, size=${buffer.length}`);
    
    try {
      await file.save(buffer, {
        contentType: 'application/pdf',
        metadata: { contentType: 'application/pdf' },
      });
      console.log(`[Upload] PDF uploaded successfully: ${filename}`);
    } catch (error: any) {
      console.error(`[Upload] Error uploading PDF: bucket=${bucketName}, object=${objectName}, error=${error?.message || error}`);
      throw error;
    }

    return `/objects/pdfs/${filename}`;
  }
}

function parseObjectPath(path: string): {
  bucketName: string;
  objectName: string;
} {
  if (!path.startsWith("/")) {
    path = `/${path}`;
  }
  const pathParts = path.split("/");
  if (pathParts.length < 3) {
    throw new Error("Invalid path: must contain at least a bucket name");
  }

  const bucketName = pathParts[1];
  const objectName = pathParts.slice(2).join("/");

  return {
    bucketName,
    objectName,
  };
}

async function signObjectURL({
  bucketName,
  objectName,
  method,
  ttlSec,
}: {
  bucketName: string;
  objectName: string;
  method: "GET" | "PUT" | "DELETE" | "HEAD";
  ttlSec: number;
}): Promise<string> {
  const request = {
    bucket_name: bucketName,
    object_name: objectName,
    method,
    expires_at: new Date(Date.now() + ttlSec * 1000).toISOString(),
  };
  const response = await fetch(
    `${REPLIT_SIDECAR_ENDPOINT}/object-storage/signed-object-url`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
    }
  );
  if (!response.ok) {
    throw new Error(
      `Failed to sign object URL, errorcode: ${response.status}, ` +
        `make sure you're running on Replit`
    );
  }

  const { signed_url: signedURL } = await response.json();
  return signedURL;
}
