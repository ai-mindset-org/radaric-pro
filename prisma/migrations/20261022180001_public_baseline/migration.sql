-- Public baseline (RAD-381). GENERATED — do not hand-edit the statements below.
-- Source: `npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script`.
-- The squashed starting point of this repository's schema; every later
-- migration applies on top of it.

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('INCOMPLETE', 'INCOMPLETE_EXPIRED', 'TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED', 'UNPAID', 'PAUSED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'USER');

-- CreateEnum
CREATE TYPE "InboxItemStatus" AS ENUM ('PENDING', 'EXTRACTING', 'EXTRACTED', 'MATCHED', 'PROCESSED', 'ERROR');

-- CreateEnum
CREATE TYPE "StoryStatus" AS ENUM ('DRAFT', 'SENT_TO_NOTION', 'ERROR');

-- CreateEnum
CREATE TYPE "SourceType" AS ENUM ('RSS', 'TELEGRAM', 'TWITTER', 'INTEREST', 'EVENT_TRIGGER', 'YOUTUBE');

-- CreateEnum
CREATE TYPE "InterestCadence" AS ENUM ('HOURLY', 'DAILY', 'WEEKLY');

-- CreateEnum
CREATE TYPE "SourceStatus" AS ENUM ('ACTIVE', 'PAUSED', 'ERROR');

-- CreateEnum
CREATE TYPE "MaterialStatus" AS ENUM ('NEW', 'READ', 'SENT_TO_NOTION', 'DELETED', 'ARCHIVED', 'SENT_TO_STORIES');

-- CreateEnum
CREATE TYPE "AIEvaluation" AS ENUM ('APPROVED', 'FILTERED');

-- CreateEnum
CREATE TYPE "FeedbackType" AS ENUM ('LIKE', 'DISLIKE');

-- CreateEnum
CREATE TYPE "BlacklistMatchType" AS ENUM ('EXACT', 'CONTAINS', 'REGEX');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "email" TEXT,
    "email_verified" TIMESTAMP(3),
    "image" TEXT,
    "password_hash" TEXT,
    "name" TEXT,
    "role" "UserRole" NOT NULL DEFAULT 'USER',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "stripe_customer_id" TEXT,
    "complimentary_access_until" TIMESTAMP(3),
    "signup_ref" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_verification_tokens" (
    "id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_verification_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_reset_tokens" (
    "id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "stripe_subscription_id" TEXT NOT NULL,
    "stripe_price_id" TEXT NOT NULL,
    "status" "SubscriptionStatus" NOT NULL,
    "current_period_start" TIMESTAMP(3) NOT NULL,
    "current_period_end" TIMESTAMP(3) NOT NULL,
    "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
    "canceled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stripe_events" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stripe_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_settings" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "global_prompt" TEXT,
    "notion_token" TEXT,
    "notion_database_id" TEXT,
    "story_inbox_channel_id" TEXT,
    "story_notion_database_id" TEXT,
    "story_last_message_id" INTEGER,
    "story_system_prompt" TEXT,
    "story_prompt_version" INTEGER DEFAULT 1,
    "story_writer_model" TEXT,
    "story_matcher_model" TEXT,
    "material_story_model" TEXT,
    "story_language" TEXT NOT NULL DEFAULT 'en',
    "auto_delete_telegram_messages" BOOLEAN NOT NULL DEFAULT false,
    "global_liked_categories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "global_disliked_categories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "onboarding_completed" BOOLEAN NOT NULL DEFAULT false,
    "onboarding_banner_dismissed" BOOLEAN NOT NULL DEFAULT false,
    "onboarding_state" JSONB,
    "typography" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_account_id" TEXT NOT NULL,
    "refresh_token" TEXT,
    "access_token" TEXT,
    "expires_at" INTEGER,
    "token_type" TEXT,
    "scope" TEXT,
    "id_token" TEXT,
    "session_state" TEXT,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "folders" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "name_lower" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "folders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sources" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "type" "SourceType" NOT NULL,
    "url" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "cover_url" TEXT,
    "favicon_url" TEXT,
    "custom_prompt" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "status" "SourceStatus" NOT NULL DEFAULT 'ACTIVE',
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "last_parsed_at" TIMESTAMP(3),
    "interest_cadence" "InterestCadence",
    "interest_query" TEXT,
    "parallel_monitor_id" TEXT,
    "liked_categories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "disliked_categories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "include_retweets" BOOLEAN NOT NULL DEFAULT false,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "folder_id" TEXT,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "monitor_delete_pending" BOOLEAN NOT NULL DEFAULT false,
    "access_paused" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "materials" (
    "id" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "published_at" TIMESTAMP(3),
    "ai_evaluation" "AIEvaluation" NOT NULL,
    "ai_confidence" INTEGER NOT NULL,
    "ai_reasoning" TEXT,
    "user_status" "MaterialStatus" NOT NULL DEFAULT 'NEW',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "parsed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "thumbnail_url" TEXT,
    "media_urls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "external_id" TEXT,
    "content_entities" JSONB,
    "story_id" TEXT,
    "story_matched_at" TIMESTAMP(3),
    "routed_at" TIMESTAMP(3),

    CONSTRAINT "materials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_feedbacks" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "material_id" TEXT,
    "source_id" TEXT,
    "feedback_type" "FeedbackType" NOT NULL DEFAULT 'DISLIKE',
    "comment_text" TEXT,
    "feedback_source" TEXT,
    "is_global" BOOLEAN NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_feedbacks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blacklist_items" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "term" TEXT NOT NULL,
    "match_type" "BlacklistMatchType" NOT NULL DEFAULT 'CONTAINS',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blacklist_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "collections" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "track_requested_at" TIMESTAMP(3),
    "synthesis" TEXT,
    "synthesis_delta" TEXT,
    "synthesis_updated_at" TIMESTAMP(3),
    "query" TEXT,
    "cadence" "InterestCadence",
    "monitor_feed_id" TEXT,
    "auto_synth_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "collections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "collection_materials" (
    "id" TEXT NOT NULL,
    "collection_id" TEXT NOT NULL,
    "material_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "collection_materials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "saved_items" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "material_id" TEXT NOT NULL,
    "collection_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "saved_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "saved_excerpts" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "material_id" TEXT NOT NULL,
    "collection_id" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "offset_start" INTEGER NOT NULL,
    "offset_end" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "saved_excerpts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inbox_items" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "message_id" INTEGER NOT NULL,
    "raw_text" TEXT,
    "raw_entities" JSONB,
    "extracted_url" TEXT,
    "extracted_title" TEXT,
    "extracted_content" TEXT,
    "media_urls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "thumbnail_url" TEXT,
    "source_channel" TEXT,
    "forwarded_from_id" TEXT,
    "telegram_post_url" TEXT,
    "all_message_ids" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "status" "InboxItemStatus" NOT NULL DEFAULT 'PENDING',
    "story_id" TEXT,
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "telegram_deleted_at" TIMESTAMP(3),
    "processed_at" TIMESTAMP(3),
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inbox_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stories" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "language_flag" TEXT,
    "summary" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "key_points" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "source_urls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "rubrics" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "archive_links" JSONB,
    "notion_page_id" TEXT,
    "notion_url" TEXT,
    "status" "StoryStatus" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings" (
    "id" TEXT NOT NULL,
    "ai_api_key" TEXT,
    "ai_model" TEXT DEFAULT 'claude-sonnet-4-6',
    "ai_temperature" DOUBLE PRECISION DEFAULT 0.3,
    "synthesis_model" TEXT,
    "discovery_model" TEXT,
    "filter_reasoning_effort" TEXT,
    "telegram_api_hash" TEXT,
    "telegram_api_id" INTEGER,
    "telegram_phone_number" TEXT,
    "telegram_session_string" TEXT,
    "parallel_api_key" TEXT,
    "parallel_webhook_secret" TEXT,
    "global_prompt" TEXT,
    "notion_token" TEXT,
    "notion_database_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_stripe_customer_id_key" ON "users"("stripe_customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "email_verification_tokens_token_hash_key" ON "email_verification_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "email_verification_tokens_user_id_idx" ON "email_verification_tokens"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_tokens_token_hash_key" ON "password_reset_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "password_reset_tokens_user_id_idx" ON "password_reset_tokens"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_user_id_key" ON "subscriptions"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_stripe_subscription_id_key" ON "subscriptions"("stripe_subscription_id");

-- CreateIndex
CREATE INDEX "subscriptions_status_idx" ON "subscriptions"("status");

-- CreateIndex
CREATE INDEX "stripe_events_type_idx" ON "stripe_events"("type");

-- CreateIndex
CREATE UNIQUE INDEX "user_settings_user_id_key" ON "user_settings"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_provider_provider_account_id_key" ON "accounts"("provider", "provider_account_id");

-- CreateIndex
CREATE INDEX "folders_user_id_idx" ON "folders"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "folder_user_name_lower_unique" ON "folders"("user_id", "name_lower");

-- CreateIndex
CREATE UNIQUE INDEX "sources_parallel_monitor_id_key" ON "sources"("parallel_monitor_id");

-- CreateIndex
CREATE INDEX "sources_user_id_idx" ON "sources"("user_id");

-- CreateIndex
CREATE INDEX "sources_folder_id_idx" ON "sources"("folder_id");

-- CreateIndex
CREATE UNIQUE INDEX "source_user_url_unique" ON "sources"("user_id", "url");

-- CreateIndex
CREATE INDEX "materials_source_id_idx" ON "materials"("source_id");

-- CreateIndex
CREATE INDEX "materials_ai_evaluation_idx" ON "materials"("ai_evaluation");

-- CreateIndex
CREATE INDEX "materials_user_status_idx" ON "materials"("user_status");

-- CreateIndex
CREATE INDEX "materials_published_at_idx" ON "materials"("published_at");

-- CreateIndex
CREATE INDEX "materials_story_id_idx" ON "materials"("story_id");

-- CreateIndex
CREATE INDEX "materials_routed_at_idx" ON "materials"("routed_at");

-- CreateIndex
CREATE UNIQUE INDEX "material_source_url_unique" ON "materials"("source_id", "url");

-- CreateIndex
CREATE UNIQUE INDEX "material_source_external_unique" ON "materials"("source_id", "external_id");

-- CreateIndex
CREATE INDEX "ai_feedbacks_user_id_idx" ON "ai_feedbacks"("user_id");

-- CreateIndex
CREATE INDEX "ai_feedbacks_source_id_idx" ON "ai_feedbacks"("source_id");

-- CreateIndex
CREATE INDEX "ai_feedbacks_is_global_idx" ON "ai_feedbacks"("is_global");

-- CreateIndex
CREATE UNIQUE INDEX "ai_feedbacks_user_material_unique" ON "ai_feedbacks"("user_id", "material_id");

-- CreateIndex
CREATE INDEX "blacklist_items_user_id_idx" ON "blacklist_items"("user_id");

-- CreateIndex
CREATE INDEX "blacklist_items_term_idx" ON "blacklist_items"("term");

-- CreateIndex
CREATE UNIQUE INDEX "blacklist_user_term_unique" ON "blacklist_items"("user_id", "term");

-- CreateIndex
CREATE UNIQUE INDEX "collections_monitor_feed_id_key" ON "collections"("monitor_feed_id");

-- CreateIndex
CREATE INDEX "collections_user_id_idx" ON "collections"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "collection_user_name_unique" ON "collections"("user_id", "name");

-- CreateIndex
CREATE INDEX "collection_materials_material_id_idx" ON "collection_materials"("material_id");

-- CreateIndex
CREATE UNIQUE INDEX "collection_material_unique" ON "collection_materials"("collection_id", "material_id");

-- CreateIndex
CREATE INDEX "saved_items_user_id_idx" ON "saved_items"("user_id");

-- CreateIndex
CREATE INDEX "saved_items_collection_id_idx" ON "saved_items"("collection_id");

-- CreateIndex
CREATE INDEX "saved_items_material_id_idx" ON "saved_items"("material_id");

-- CreateIndex
CREATE UNIQUE INDEX "saved_item_user_material_unique" ON "saved_items"("user_id", "material_id");

-- CreateIndex
CREATE INDEX "saved_excerpts_user_id_idx" ON "saved_excerpts"("user_id");

-- CreateIndex
CREATE INDEX "saved_excerpts_collection_id_idx" ON "saved_excerpts"("collection_id");

-- CreateIndex
CREATE INDEX "saved_excerpts_material_id_idx" ON "saved_excerpts"("material_id");

-- CreateIndex
CREATE UNIQUE INDEX "inbox_items_external_id_key" ON "inbox_items"("external_id");

-- CreateIndex
CREATE INDEX "inbox_items_user_id_status_idx" ON "inbox_items"("user_id", "status");

-- CreateIndex
CREATE INDEX "inbox_items_user_id_created_at_idx" ON "inbox_items"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "stories_user_id_status_idx" ON "stories"("user_id", "status");

-- CreateIndex
CREATE INDEX "stories_user_id_created_at_idx" ON "stories"("user_id", "created_at");

-- AddForeignKey
ALTER TABLE "email_verification_tokens" ADD CONSTRAINT "email_verification_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "folders" ADD CONSTRAINT "folders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sources" ADD CONSTRAINT "sources_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sources" ADD CONSTRAINT "sources_folder_id_fkey" FOREIGN KEY ("folder_id") REFERENCES "folders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "materials" ADD CONSTRAINT "materials_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "materials" ADD CONSTRAINT "materials_story_id_fkey" FOREIGN KEY ("story_id") REFERENCES "stories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_feedbacks" ADD CONSTRAINT "ai_feedbacks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_feedbacks" ADD CONSTRAINT "ai_feedbacks_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "materials"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_feedbacks" ADD CONSTRAINT "ai_feedbacks_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blacklist_items" ADD CONSTRAINT "blacklist_items_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collections" ADD CONSTRAINT "collections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collections" ADD CONSTRAINT "collections_monitor_feed_id_fkey" FOREIGN KEY ("monitor_feed_id") REFERENCES "sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collection_materials" ADD CONSTRAINT "collection_materials_collection_id_fkey" FOREIGN KEY ("collection_id") REFERENCES "collections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collection_materials" ADD CONSTRAINT "collection_materials_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "materials"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_items" ADD CONSTRAINT "saved_items_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_items" ADD CONSTRAINT "saved_items_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "materials"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_items" ADD CONSTRAINT "saved_items_collection_id_fkey" FOREIGN KEY ("collection_id") REFERENCES "collections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_excerpts" ADD CONSTRAINT "saved_excerpts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_excerpts" ADD CONSTRAINT "saved_excerpts_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "materials"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_excerpts" ADD CONSTRAINT "saved_excerpts_collection_id_fkey" FOREIGN KEY ("collection_id") REFERENCES "collections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbox_items" ADD CONSTRAINT "inbox_items_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbox_items" ADD CONSTRAINT "inbox_items_story_id_fkey" FOREIGN KEY ("story_id") REFERENCES "stories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stories" ADD CONSTRAINT "stories_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

