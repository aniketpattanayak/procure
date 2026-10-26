-- 0020 Catalogue honesty (release review): catalogue entries without an implementation are labelled "coming soon" so
-- the Super Admin plan editor and the tenant usage page don't sell them. Text only; keys stay (plans that already
-- list them keep working, and the entries become real when the features ship). Owner: platform/devops.
UPDATE platform.feature_catalog
   SET name = 'Two-factor login (coming soon)',
       description = 'Coming soon: OTP second factor at sign-in. Not implemented yet; enabling it has no effect.'
 WHERE key = 'two_factor';

UPDATE platform.feature_catalog
   SET description = 'Outgoing webhooks. REST API keys: coming soon.'
 WHERE key = 'api_access';

UPDATE platform.limit_catalog
   SET name = 'API calls / month (coming soon)'
 WHERE key = 'api_calls_per_month';
