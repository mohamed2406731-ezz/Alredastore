# Cloudinary media integration

Cloudinary's official Node SDK and Multer are installed. The media layer supports uploads, optimized delivery, import mapping and guarded replacement/deletion. The active manifest contains 922 Cloudinary assets, including a mapped Cloudinary asset for each of the catalog's 898 product gallery images. The product-image cache under `src/public/images/products` is intentionally excluded from this project copy. Existing catalog images are delivered from the Cloudinary account recorded in the manifest, while runtime Cloudinary credentials can point to a different account for future uploads. `CLOUDINARY_ROOT_FOLDER` must still match the manifest root. Small branding, hero and PWA assets remain local. The storefront catalog remains sourced from `src/config/catalog.json`; the catalog importer stores only Cloudinary URLs and asset IDs, never image binaries.

## Configuration

Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET and CLOUDINARY_ROOT_FOLDER in local `.env` or runtime secrets. The root defaults to `alreda-store`. Product gallery delivery requires Cloudinary to be enabled; partial credentials cause startup validation to fail with field names only. Never put credentials in EJS, import manifests or committed files. `.env` remains ignored.

CLOUDINARY_FOLDER_MODE defaults to `auto`, which reads the account's folder mode once using the Admin API. Accounts with restricted config-read permissions can explicitly select their verified `fixed` or `dynamic` mode. Dynamic mode sets `asset_folder` and a stable full public ID; fixed mode uses `folder` and a hash public ID. Both produce the intended folder hierarchy. No upload is sent to the Cloudinary root.

MEDIA_MAX_UPLOAD_BYTES defaults to 20 MiB, configurable up to 40 MiB. MEDIA_MAX_IMAGE_COUNT defaults to 12, capped at 20. JPEG, PNG, WebP and AVIF are accepted only after decoding actual image bytes with Sharp; mismatched MIME, corrupt data, SVG, animated images and excessive dimensions are rejected. Original filenames are never used as storage paths. Originals are uploaded without incoming transformations. Delivery uses bounded `c_limit`, `f_auto`, `q_auto` profiles for thumbnails, cards, details and desktop/mobile banners.

## Service and persistence boundary

`createCloudinaryService({ config, client, authorize, repository, journal })` defaults to denying every mutation. Its upload methods take `(buffer, target, context)`. The authorization policy must derive the acting administrator from verified server-side authentication and check the requested product/category/variant ownership. Never authorize using body/query role or user IDs. `createUploadMiddleware` likewise requires an explicit verified-admin policy and runs it before parsing multipart bytes. Future routes must also enforce CSRF. No public upload/deletion endpoints or admin UI are mounted in this phase.

Targets contain entityId, optional SKU/slug/variantId, altText and displayOrder. Banner targets select homepage/promotions/seasonal and optional desktop/mobile device; branding selects logos/icons; page media selects about/contact. Products use `<root>/products/<SKU>/main|gallery|variants`. Categories, collections, banners, branding, pages and temporary/imports follow the requested hierarchy. Traversal/path separators are rejected. Unicode identifiers receive stable hash-suffixed filesystem-safe keys. Missing business SKUs use `source-<source ID>` folders, without inventing SKU values.

Returned metadata contains publicId, assetId, secureUrl, resourceType, width, height, format, bytes, version, hash, target, association, altText and displayOrder. A future Prisma adapter maps these to the existing product-image/category/banner models; no duplicate media table is introduced here.

The injected repository contract is:

- `attachImage(record, context)`: return the stored media ID after validating association ownership.
- `getImage(mediaId, context)`: fetch only an authorized association, including provider metadata, kind, target and association.
- `replaceImageAssociation(id, expectedAssetId, replacement, context)`: transactional compare-and-swap, rejecting concurrent changes.
- `detachImage(id, expectedAssetId, context)`: remove only the authorized association, preserving historical references.
- `withUnreferencedAsset(record, callback)`: hold a database lock shared by **all** association creators/removers; invoke the callback only if no product, variant, historical or other references remain. Otherwise return `{ retained: true }`.

Replace/delete fail closed without this adapter. Replacement uploads and confirms the new asset before updating the association. Failed association updates retain the old asset and journal the possible orphan. Cleanup deletes by immutable asset ID, with CDN invalidation, only under the reference guard. Failed cleanup is reported as pending and recorded for reconciliation. Local imports journal to `data/media/reconciliation.jsonl`, ignored by Git. On Vercel, verified admin operations write grouped `MEDIA_<EVENT>:<group>` rows to the existing `admin_audit_events` table, with `public:`, `asset:`, `media:` and `code:` identifiers in `target_id`; rows sharing an action belong to one event. Scheduled cleanup relies on its existing persistent job and never invents an administrator identity. Credentials, signed parameters and raw provider errors are never journaled. No production asset was deleted during verification.

## Catalog migration and delivery

```powershell
# Plan only: no Cloudinary network requests, no delivery activation.
npm.cmd run media:migrate
# After configuring an authorized account, deliberately upload/resume existing local originals.
npm.cmd run media:migrate -- --execute
# Recheck/re-upload deterministic IDs after external Cloudinary changes.
npm.cmd run media:migrate -- --execute --refresh-existing
# Optional Cloudinary stage during an intentional full catalog refresh.
npm.cmd run catalog:import -- --cached --cloudinary --activate
```

The verified dry run planned **922 image-association jobs**: 898 product gallery relationships, 21 supplied collection images and three active banner/branding assets. Seven missing collection images are skipped explicitly; all 237 products lack a usable SKU and use source-ID folders. A product's first image has the main role; other variant-associated photos use variants, and remaining photos use gallery. Variant links to the main photo reuse that main asset. No new images or homepage collections are invented.

Stable folder/content-hash IDs, `overwrite: false`, an in-process cache and resumable verified mappings prevent duplicate stored assets. Retryable provider failures use bounded backoff; account/rate restrictions stop the batch. Reports/checkpoints under `data/media/cloudinary-import.json` preserve original product/image URLs, local IDs, Cloudinary identifiers and all variant-image associations. Only a complete import activates `src/config/cloudinary-media.json`; checksum ownership refuses to overwrite later manual edits. Run one import at a time. A process interrupted after activation but before its ownership checkpoint may require manual reconciliation; never delete remote assets merely to clear a checkpoint.

The delivery service overlays local catalog URLs from the activated mapping, without changing the source inventory. Product/variant galleries, collections, hero, logo and WhatsApp icon can use Cloudinary URLs. Missing/inactive mappings retain local images. CSP permits only the configured Cloudinary image namespace. No credentials enter templates. Restart the application after activating a mapping; production files are not watched.

## Verification and remaining work

Mock tests cover folder modes/roles, upload metadata, duplicate prevention, file formats/validation, authorization, repository association, replacement order, shared-asset retention, failed cleanup, optimized URLs, migration resume/failure and manifest protection. Existing storefront checks verify local fallback and unchanged navigation/gallery/WhatsApp behavior. Completed on 2026-11-02: all 922 planned image jobs uploaded or reused successfully, with zero failures. The active manifest contains 922 HTTPS Cloudinary records; delivery verification confirms all 898 product gallery images and all 21 supplied collection images resolve through `res.cloudinary.com`, and the configured cloud name and root folder match. Three representative product, detail-gallery, and collection URLs returned HTTP 200 from the CDN. All 922 source files passed checksum/path preflight (about 758 MiB). Focused Cloudinary, migration, and catalog-import tests passed (59/59). No database records or local image files were deleted; a read-only Neon audit found no product rows or image URLs. A live source audit matched all 237 published products and all 898 product images. All 28 collections matched; 21 have official cover images and all were migrated. Seven source collections have no official image; six also have no products. The homepage hero matched the local asset exactly, and the 600x600 official logo source is now stored locally and in Cloudinary. The transparent WhatsApp icon remains the customized storefront asset. The catalog migration and importer now persist 237 products, 28 collections, 1,074 variants, collection membership, and 898 Cloudinary image references; binary image data is never written to PostgreSQL. The storefront still uses the local catalog snapshot. Database-backed storefront reads, authenticated admin catalog editing, real stock setup and checkout activation remain separate work.

Primary references: [Node SDK](https://cloudinary.com/documentation/node_integration), [folder modes](https://cloudinary.com/documentation/folder_modes), [Upload API](https://cloudinary.com/documentation/image_upload_api_reference), [Admin deletion by asset ID](https://cloudinary.com/documentation/admin_api#delete_resources_by_asset_id).

Created: `src/config/cloudinary.js`, `src/services/cloudinary.service.js`, `src/services/media-delivery.service.js`, `src/middleware/upload.middleware.js`, `src/utils/mediaPath.js`, `src/validators/media.validator.js`, `src/repositories/media-journal.repository.js`, `scripts/catalog-import/cloudinary.js`, media unit/integration tests and mock SDK helper. Updated: environment validation/example, package manifests, ignore rules, app CSP/template helper, catalog repository, active-image EJS references and catalog-import entry point. Local credentials and catalog records were preserved.
