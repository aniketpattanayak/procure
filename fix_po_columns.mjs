#!/usr/bin/env node
/**
 * Fixes the PO line form column order for the Jeevaka tenant.
 * Changes the column order from: uom → qty → item → rate → ...
 * To the correct order:         item → uom → qty → rate → ...
 *
 * This creates a new form version with the correct field order.
 */
import pg from 'pg';

const DATABASE_URL = 'postgres://app_user:app_pass@localhost:5432/procure';
const PO_LINE_FORM_KEY = 'po.line';

async function main() {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  console.log('Connected to DB');

  try {
    // 1. Find the PO line form and its current version
    const formRes = await client.query(`
      SELECT fd.id as form_id, fd.key, fd.current_version_id, fd.tenant_id,
             fv.definition, fv.version as current_version
      FROM app.form_def fd
      JOIN app.form_version fv ON fv.id = fd.current_version_id
      WHERE fd.key = $1
    `, [PO_LINE_FORM_KEY]);

    if (formRes.rows.length === 0) {
      console.error('PO line form not found!');
      process.exit(1);
    }

    console.log(`Found ${formRes.rows.length} tenant(s) with PO line form`);

    for (const row of formRes.rows) {
      console.log(`\nTenant: ${row.tenant_id}, Form ID: ${row.form_id}, Version: ${row.current_version}`);

      const def = typeof row.definition === 'string' ? JSON.parse(row.definition) : row.definition;
      const fields = def.fields || [];

      console.log('Current field order:', fields.filter(f => !f.removed && !f.hidden).map(f => f.key).join(' → '));

      // Reorder: item first, then uom, then qty, then the rest
      const itemField = fields.find(f => f.key === 'item');
      const uomField = fields.find(f => f.key === 'uom');
      const qtyField = fields.find(f => f.key === 'qty');
      const otherFields = fields.filter(f => !['item', 'uom', 'qty'].includes(f.key));

      if (!itemField) {
        console.log('No item field found, skipping');
        continue;
      }

      const reordered = [
        itemField,
        ...(uomField ? [uomField] : []),
        ...(qtyField ? [qtyField] : []),
        ...otherFields,
      ];

      console.log('New field order:', reordered.filter(f => !f.removed && !f.hidden).map(f => f.key).join(' → '));

      const newDef = { ...def, fields: reordered };

      // Create a new form version with the reordered fields
      await client.query('BEGIN');
      try {
        const nextVersion = row.current_version + 1;
        const versionRes = await client.query(`
          INSERT INTO app.form_version (tenant_id, form_id, version, definition, change_note, published_by)
          VALUES ($1, $2, $3, $4, $5, (SELECT id FROM app.user_ WHERE tenant_id = $1 LIMIT 1))
          RETURNING id
        `, [row.tenant_id, row.form_id, nextVersion, JSON.stringify(newDef), 'Fix column order: item → unit → qty']);

        const newVersionId = versionRes.rows[0].id;

        // Update form_def to point to the new version
        await client.query(`
          UPDATE app.form_def
          SET current_version_id = $1, draft = NULL, draft_updated_at = NULL, draft_updated_by = NULL
          WHERE id = $2
        `, [newVersionId, row.form_id]);

        await client.query('COMMIT');
        console.log(`✅ Created new version ${nextVersion} (id: ${newVersionId}) for tenant ${row.tenant_id}`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error('Failed:', err.message);
      }
    }
  } finally {
    await client.end();
    console.log('\nDone!');
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
