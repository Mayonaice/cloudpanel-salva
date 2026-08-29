import { relations } from "drizzle-orm";
import { bigint, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const uploadStatus = pgEnum("cloud_upload_status", ["initiated", "uploading", "completing", "completed", "aborted", "failed"]);
export const fileStatus = pgEnum("cloud_file_status", ["uploading", "ready", "trashed", "purge_pending", "purged"]);
export const jobStatus = pgEnum("cloud_job_status", ["queued", "leased", "completed", "failed", "dead"]);

export const users = pgTable("cloud_users", {
  id: uuid("id").defaultRandom().primaryKey(),
  googleSubject: text("google_subject").notNull(),
  email: text("email").notNull(),
  displayName: text("display_name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
}, (table) => ({
  googleSubjectUnique: uniqueIndex("cloud_users_google_subject_unique").on(table.googleSubject),
  emailUnique: uniqueIndex("cloud_users_email_unique").on(table.email)
}));

export const guestKeys = pgTable("cloud_guest_keys", {
  id: uuid("id").defaultRandom().primaryKey(),
  ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  role: text("role").notNull(),
  tokenHash: text("token_hash").notNull(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
}, (table) => ({
  tokenUnique: uniqueIndex("cloud_guest_keys_token_hash_unique").on(table.tokenHash),
  ownerIndex: index("cloud_guest_keys_owner_idx").on(table.ownerId)
}));

export const storageConnections = pgTable("cloud_storage_connections", {
  id: uuid("id").defaultRandom().primaryKey(),
  ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
  endpoint: text("endpoint").notNull(),
  bucket: text("bucket"),
  region: text("region"),
  prefix: text("prefix").notNull().default(""),
  credentialsCiphertext: text("credentials_ciphertext").notNull(),
  quotaBytes: bigint("quota_bytes", { mode: "number" }),
  usedBytes: bigint("used_bytes", { mode: "number" }).notNull().default(0),
  disconnectedAt: timestamp("disconnected_at", { withTimezone: true }),
  checkedAt: timestamp("checked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
}, (table) => ({ ownerIndex: index("cloud_storage_connections_owner_idx").on(table.ownerId) }));

export const folders = pgTable("cloud_folders", {
  id: uuid("id").defaultRandom().primaryKey(),
  ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  storageId: uuid("storage_id").notNull().references(() => storageConnections.id, { onDelete: "cascade" }),
  parentId: uuid("parent_id"),
  name: text("name").notNull(),
  storagePath: text("storage_path"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
}, (table) => ({
  ownerParentIndex: index("cloud_folders_owner_parent_idx").on(table.ownerId, table.parentId),
  ownerNameIndex: index("cloud_folders_owner_name_idx").on(table.ownerId, table.name),
  storagePathUnique: uniqueIndex("cloud_folders_storage_path_unique").on(table.storageId, table.storagePath)
}));

export const files = pgTable("cloud_files", {
  id: uuid("id").defaultRandom().primaryKey(),
  ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  storageId: uuid("storage_id").notNull().references(() => storageConnections.id, { onDelete: "cascade" }),
  folderId: uuid("folder_id").references(() => folders.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  contentType: text("content_type").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  objectKey: text("object_key").notNull(),
  status: fileStatus("status").notNull().default("uploading"),
  checksumSha256: text("checksum_sha256"),
  trashedAt: timestamp("trashed_at", { withTimezone: true }),
  purgedAt: timestamp("purged_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
}, (table) => ({
  objectKeyUnique: uniqueIndex("cloud_files_storage_key_unique").on(table.storageId, table.objectKey),
  ownerFolderIndex: index("cloud_files_owner_folder_idx").on(table.ownerId, table.folderId),
  ownerStatusIndex: index("cloud_files_owner_status_idx").on(table.ownerId, table.status),
  ownerNameIndex: index("cloud_files_owner_name_idx").on(table.ownerId, table.name)
}));

export const uploadSessions = pgTable("cloud_upload_sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  storageId: uuid("storage_id").notNull().references(() => storageConnections.id, { onDelete: "cascade" }),
  fileId: uuid("file_id").notNull().references(() => files.id, { onDelete: "cascade" }),
  idempotencyKey: text("idempotency_key").notNull(),
  providerUploadId: text("provider_upload_id"),
  status: uploadStatus("status").notNull().default("initiated"),
  reservedBytes: bigint("reserved_bytes", { mode: "number" }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
}, (table) => ({
  idempotencyUnique: uniqueIndex("cloud_upload_sessions_storage_idempotency_unique").on(table.storageId, table.idempotencyKey),
  ownerStatusIndex: index("cloud_upload_sessions_owner_status_idx").on(table.ownerId, table.status),
  expiryIndex: index("cloud_upload_sessions_expiry_idx").on(table.expiresAt)
}));

export const shares = pgTable("cloud_shares", {
  id: uuid("id").defaultRandom().primaryKey(),
  ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  fileId: uuid("file_id").notNull().references(() => files.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  passwordHash: text("password_hash"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
}, (table) => ({
  tokenUnique: uniqueIndex("cloud_shares_token_hash_unique").on(table.tokenHash),
  fileIndex: index("cloud_shares_file_idx").on(table.fileId)
}));

export const jobs = pgTable("cloud_jobs", {
  id: uuid("id").defaultRandom().primaryKey(),
  kind: text("kind").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  status: jobStatus("status").notNull().default("queued"),
  attempts: integer("attempts").notNull().default(0),
  availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
}, (table) => ({
  claimIndex: index("cloud_jobs_claim_idx").on(table.status, table.availableAt),
  leaseIndex: index("cloud_jobs_lease_idx").on(table.leaseUntil)
}));

export const auditEvents = pgTable("cloud_audit_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  ownerId: uuid("owner_id").references(() => users.id, { onDelete: "set null" }),
  action: text("action").notNull(),
  resourceType: text("resource_type"),
  resourceId: uuid("resource_id"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
}, (table) => ({
  ownerTimeIndex: index("cloud_audit_owner_time_idx").on(table.ownerId, table.createdAt)
}));

export const rateLimits = pgTable("cloud_rate_limits", {
  key: text("key").primaryKey(),
  count: integer("count").notNull(),
  resetAt: timestamp("reset_at", { withTimezone: true }).notNull()
}, (table) => ({ expiryIndex: index("cloud_rate_limits_expiry_idx").on(table.resetAt) }));

export const userRelations = relations(users, ({ many }) => ({ files: many(files), folders: many(folders), uploads: many(uploadSessions), shares: many(shares) }));
export const folderRelations = relations(folders, ({ one, many }) => ({ owner: one(users, { fields: [folders.ownerId], references: [users.id] }), files: many(files) }));
export const fileRelations = relations(files, ({ one, many }) => ({ owner: one(users, { fields: [files.ownerId], references: [users.id] }), folder: one(folders, { fields: [files.folderId], references: [folders.id] }), uploads: many(uploadSessions), shares: many(shares) }));
export const uploadRelations = relations(uploadSessions, ({ one }) => ({ owner: one(users, { fields: [uploadSessions.ownerId], references: [users.id] }), file: one(files, { fields: [uploadSessions.fileId], references: [files.id] }) }));
export const shareRelations = relations(shares, ({ one }) => ({ owner: one(users, { fields: [shares.ownerId], references: [users.id] }), file: one(files, { fields: [shares.fileId], references: [files.id] }) }));
