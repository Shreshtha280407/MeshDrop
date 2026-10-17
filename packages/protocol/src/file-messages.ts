import { z } from 'zod';
import { MAX_UINT32, VERIFICATION_BLOCK_BYTES } from './constants';
import { uuidSchema } from './schemas';

export const MAX_TRANSFER_FILES = 16;
export const MAX_TRANSFER_BYTES = 64 * 1024 ** 3;
export const TRANSFER_FRAME_HEADER_BYTES = 72;
export const MIN_TRANSFER_FRAME_BYTES = 1024;
export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export function safeRelativePath(value: string): boolean {
  if (
    !value ||
    value !== value.normalize('NFC') ||
    new TextEncoder().encode(value).length > 240 ||
    /[\\\u202a-\u202e\u2066-\u2069:<>"|?*]/u.test(value) ||
    Array.from(value).some((char) => {
      const point = char.codePointAt(0)!;
      return point < 32 || (point >= 127 && point <= 159);
    })
  )
    return false;
  const parts = value.split('/');
  return (
    parts.length <= 8 &&
    parts.every(
      (part) =>
        part.length > 0 &&
        part === part.trim() &&
        part !== '.' &&
        part !== '..' &&
        !/[. ]$/.test(part) &&
        !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part),
    )
  );
}
export const relativePathSchema = z.string().refine(safeRelativePath, 'Unsafe relative path.');
export const manifestFileSchema = z.strictObject({
  fileId: uuidSchema,
  path: relativePathSchema,
  size: z.number().int().min(0).max(MAX_TRANSFER_BYTES),
  sha256: sha256Schema,
});
export const manifestSchema = z
  .strictObject({
    version: z.literal(1),
    transferId: uuidSchema,
    revision: z.literal(1),
    blockBytes: z.literal(VERIFICATION_BLOCK_BYTES),
    files: z.array(manifestFileSchema).min(1).max(MAX_TRANSFER_FILES),
    totalBytes: z.number().int().min(0).max(MAX_TRANSFER_BYTES),
  })
  .superRefine((manifest, ctx) => {
    if (
      manifest.files.reduce((sum, file) => sum + file.size, 0) !== manifest.totalBytes ||
      new Set(manifest.files.map((file) => file.fileId)).size !== manifest.files.length ||
      new Set(manifest.files.map((file) => file.path.toLowerCase())).size !== manifest.files.length
    )
      ctx.addIssue({ code: 'custom', message: 'Manifest totals or file identities conflict.' });
  });
export const receiptSchema = z.strictObject({
  receiptId: uuidSchema,
  transferId: uuidSchema,
  manifestDigest: sha256Schema,
  epoch: z.number().int().min(1).max(MAX_UINT32),
  totalBytes: z.number().int().min(0).max(MAX_TRANSFER_BYTES),
  files: z.array(manifestFileSchema).min(1).max(MAX_TRANSFER_FILES),
  destination: z.literal('browser-temporary'),
  completedAt: z.iso.datetime(),
});
const context = {
  version: z.literal(1),
  roomId: uuidSchema,
  peerId: uuidSchema,
  epoch: z.number().int().min(1).max(MAX_UINT32),
  transcript: sha256Schema,
  messageId: uuidSchema,
  seq: z.number().int().min(0).max(MAX_UINT32),
  transferId: uuidSchema,
};
export const RESUME_PROOF_PAGE_SIZE = 32;
export const blockProofSchema = z.strictObject({
  fileId: uuidSchema,
  index: z.number().int().min(0).max(65535),
  digest: sha256Schema,
});
const resumeContext = {
  attemptId: uuidSchema,
  manifestDigest: sha256Schema,
};
export const fileControlSchema = z.discriminatedUnion('type', [
  z.strictObject({
    ...context,
    type: z.literal('RESUME_UNAVAILABLE'),
    payload: z.strictObject({
      ...resumeContext,
      reason: z.enum(['source-required', 'checkpoint-mismatch']),
    }),
  }),
  z.strictObject({
    ...context,
    type: z.literal('RESUME_HELLO'),
    payload: z.strictObject({
      ...resumeContext,
      checkpointDigest: sha256Schema,
    }),
  }),
  z.strictObject({
    ...context,
    type: z.literal('MANIFEST_CONFIRM'),
    payload: z.strictObject({
      ...resumeContext,
      manifest: manifestSchema,
    }),
  }),
  z.strictObject({
    ...context,
    type: z.literal('HAVE_RANGES'),
    payload: z.strictObject({
      ...resumeContext,
      page: z.number().int().min(0).max(2048),
      last: z.boolean(),
      blocks: z.array(blockProofSchema).max(RESUME_PROOF_PAGE_SIZE),
    }),
  }),
  z.strictObject({
    ...context,
    type: z.literal('NEED_RANGES'),
    payload: z.strictObject({
      ...resumeContext,
      page: z.number().int().min(0).max(2048),
      rejected: z
        .array(
          z
            .number()
            .int()
            .min(0)
            .max(RESUME_PROOF_PAGE_SIZE - 1),
        )
        .max(RESUME_PROOF_PAGE_SIZE),
    }),
  }),
  z.strictObject({
    ...context,
    type: z.literal('RESUME_ACCEPT'),
    payload: z.strictObject({
      ...resumeContext,
      checkpointDigest: sha256Schema,
      reusedBytes: z.number().int().min(0).max(MAX_TRANSFER_BYTES),
    }),
  }),
  z.strictObject({
    ...context,
    type: z.literal('TRANSFER_OFFER'),
    payload: z.strictObject({ manifest: manifestSchema, manifestDigest: sha256Schema }),
  }),
  z.strictObject({
    ...context,
    type: z.literal('TRANSFER_ACCEPT'),
    payload: z.strictObject({
      manifestDigest: sha256Schema,
      destination: z.literal('browser-temporary'),
    }),
  }),
  z.strictObject({
    ...context,
    type: z.literal('TRANSFER_REJECT'),
    payload: z.strictObject({ reason: z.enum(['declined', 'unsupported', 'storage']) }),
  }),
  z.strictObject({
    ...context,
    type: z.literal('BLOCK_START'),
    payload: z.strictObject({
      fileId: uuidSchema,
      blockIndex: z.number().int().min(0).max(MAX_UINT32),
      bytes: z.number().int().min(1).max(VERIFICATION_BLOCK_BYTES),
      digest: sha256Schema,
    }),
  }),
  z.strictObject({
    ...context,
    type: z.literal('BLOCK_ACK'),
    payload: z.strictObject({
      fileId: uuidSchema,
      blockIndex: z.number().int().min(0).max(MAX_UINT32),
      digest: sha256Schema,
      committedBytes: z.number().int().min(1).max(MAX_TRANSFER_BYTES),
    }),
  }),
  z.strictObject({
    ...context,
    type: z.literal('FLOW_STATE'),
    payload: z.strictObject({ paused: z.boolean() }),
  }),
  z.strictObject({
    ...context,
    type: z.literal('TRANSFER_CANCEL'),
    payload: z.strictObject({
      reason: z.enum(['user', 'connection', 'timeout', 'invalid-data', 'storage', 'integrity']),
    }),
  }),
  z.strictObject({
    ...context,
    type: z.literal('FILE_END'),
    payload: z.strictObject({ fileId: uuidSchema }),
  }),
  z.strictObject({
    ...context,
    type: z.literal('FILE_VERIFIED'),
    payload: z.strictObject({
      fileId: uuidSchema,
      sha256: sha256Schema,
      storageFinalized: z.literal(true),
    }),
  }),
  z.strictObject({
    ...context,
    type: z.literal('TRANSFER_FINALIZE'),
    payload: z.strictObject({ manifestDigest: sha256Schema }),
  }),
  z.strictObject({ ...context, type: z.literal('TRANSFER_RECEIPT'), payload: receiptSchema }),
  z.strictObject({
    ...context,
    type: z.literal('RECEIPT_ACK'),
    payload: z.strictObject({ receiptId: uuidSchema, manifestDigest: sha256Schema }),
  }),
]);
export const signedFileControlSchema = z.strictObject({
  control: fileControlSchema,
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
});
export type BlockProof = z.infer<typeof blockProofSchema>;
export type TransferManifest = z.infer<typeof manifestSchema>;
export type TransferFile = z.infer<typeof manifestFileSchema>;
export type TransferReceipt = z.infer<typeof receiptSchema>;
export type FileControl = z.infer<typeof fileControlSchema>;
export type FileControlInput = FileControl extends infer C
  ? C extends FileControl
    ? Pick<C, 'type' | 'transferId' | 'payload'>
    : never
  : never;
