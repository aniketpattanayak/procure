const API_BASE = "https://procure-api-2g2v.onrender.com/api/v1";
const TENANT_ID = "01a17d6a-ce85-7c29-a7d7-719d8dae970a";

async function login() {
  const res = await fetch(`${API_BASE}/auth/platform/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "owner@procure.local", password: "Owner@12345" }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Login failed: ${JSON.stringify(data)}`);
  return data.token || data.access_token || data.data?.token || data.data?.access_token;
}

async function impersonate(platformToken) {
  const res = await fetch(`${API_BASE}/platform/tenants/${TENANT_ID}/impersonate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${platformToken}`,
    },
    body: JSON.stringify({ reason: "setup permissions" }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Impersonate failed: ${JSON.stringify(data)}`);
  return data.token || data.access_token || data.data?.token || data.data?.access_token;
}

async function getRoles(token) {
  const res = await fetch(`${API_BASE}/roles`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Get roles failed: ${JSON.stringify(data)}`);
  return data.data || data.roles || data;
}

async function setPermissions(token, roleId, roleName, grants) {
  const body = { grants: grants.map((key) => ({ key, effect: "allow" })) };
  const res = await fetch(`${API_BASE}/roles/${roleId}/permissions`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    console.error(`  FAILED [${roleName}]: ${res.status} ${JSON.stringify(data)}`);
    return false;
  }
  console.log(`  OK [${roleName}]: ${grants.length} grants applied`);
  return true;
}

const ROLE_PERMISSIONS = {
  indenter: [
    "doc.indent",
    "doc.indent:action.view",
    "doc.indent:action.add",
    "doc.indent:action.edit",
    "doc.indent:action.submit",
    "doc.indent:action.cancel",
    "doc.indent:action.attach",
    "doc.indent:action.comment",
    "doc.indent:action.print",
    "doc.indent:view.draft",
    "doc.indent:view.waiting_verify",
    "master.item:action.view",
    "master.uom:action.view",
    "master.department:action.view",
    "approvals:action.view",
  ],

  hod: [
    "doc.indent",
    "doc.indent:action.view",
    "doc.indent:action.stage_verify",
    "doc.indent:action.comment",
    "doc.indent:action.attach",
    "doc.indent:action.print",
    "doc.indent:view.draft",
    "doc.indent:view.waiting_verify",
    "doc.indent:view.approved",
    "doc.indent:view.rejected",
    "doc.grn",
    "doc.grn:action.view",
    "doc.grn:action.stage_approve",
    "doc.grn:action.comment",
    "doc.grn:action.print",
    "doc.grn:view.waiting_approve",
    "doc.grn:view.approved",
    "doc.grn:view.rejected",
    "doc.po",
    "doc.po:action.view",
    "doc.po:action.stage_approve",
    "doc.po:action.comment",
    "doc.po:action.print",
    "doc.po:view.waiting_approve",
    "doc.po:view.approved",
    "approvals:action.view",
    "master.item:action.view",
    "master.vendor:action.view",
    "master.department:action.view",
    "dashboards:action.view",
    "reports:action.view",
  ],

  purchase: [
    "doc.indent:action.view",
    "doc.indent:action.log_quote",
    "doc.indent:action.comment",
    "doc.indent:view.approved",
    "doc.vendor_selection",
    "doc.vendor_selection:action.view",
    "doc.vendor_selection:action.add",
    "doc.vendor_selection:action.edit",
    "doc.vendor_selection:action.comment",
    "doc.vendor_selection:action.attach",
    "doc.vendor_selection:view.draft",
    "master.vendor:action.view",
    "master.vendor:action.add",
    "master.vendor:action.edit",
    "master.item:action.view",
    "master.payment_terms:action.view",
    "master.tax_code:action.view",
    "master.terms:action.view",
    "approvals:action.view",
  ],

  vendor_select: [
    "doc.indent:action.view",
    "doc.indent:action.compare",
    "doc.indent:view.approved",
    "doc.vendor_selection",
    "doc.vendor_selection:action.view",
    "doc.vendor_selection:action.edit",
    "doc.vendor_selection:action.submit",
    "doc.vendor_selection:action.stage_approve",
    "doc.vendor_selection:action.finalize",
    "doc.vendor_selection:action.comment",
    "doc.vendor_selection:action.print",
    "doc.vendor_selection:view.draft",
    "doc.vendor_selection:view.waiting_approve",
    "doc.vendor_selection:view.approved",
    "master.vendor:action.view",
    "master.item:action.view",
    "master.payment_terms:action.view",
    "reports:action.view",
    "approvals:action.view",
  ],

  purchase_po: [
    "doc.po",
    "doc.po:action.view",
    "doc.po:action.add",
    "doc.po:action.edit",
    "doc.po:action.submit",
    "doc.po:action.cancel",
    "doc.po:action.close",
    "doc.po:action.copy",
    "doc.po:action.comment",
    "doc.po:action.attach",
    "doc.po:action.print",
    "doc.po:action.send_email",
    "doc.po:action.send_whatsapp",
    "doc.po:action.amend",
    "doc.po:action.create_direct",
    "doc.po:action.followup",
    "doc.po:view.draft",
    "doc.po:view.waiting_approve",
    "doc.po:view.approved",
    "doc.po:view.cancelled",
    "doc.po:view.closed",
    "doc.vendor_selection:action.view",
    "doc.vendor_selection:view.approved",
    "master.vendor:action.view",
    "master.item:action.view",
    "master.payment_terms:action.view",
    "master.tax_code:action.view",
    "master.terms:action.view",
    "approvals:action.view",
  ],

  accounts: [
    "doc.po",
    "doc.po:action.view",
    "doc.po:action.stage_approve",
    "doc.po:action.comment",
    "doc.po:action.print",
    "doc.po:view.waiting_approve",
    "doc.po:view.approved",
    "doc.po:view.rejected",
    "doc.grn:action.view",
    "doc.grn:view.approved",
    "reports:action.view",
    "reports:action.export",
    "dashboards:action.view",
    "master.vendor:action.view",
    "master.item:action.view",
    "master.payment_terms:action.view",
    "master.tax_code:action.view",
    "approvals:action.view",
  ],

  gate: [
    "doc.grn",
    "doc.grn:action.view",
    "doc.grn:action.add",
    "doc.grn:action.edit",
    "doc.grn:action.submit",
    "doc.grn:action.attach",
    "doc.grn:action.comment",
    "doc.grn:action.print",
    "doc.grn:view.draft",
    "doc.grn:view.waiting_approve",
    "doc.po:action.view",
    "doc.po:view.approved",
    "master.vendor:action.view",
    "master.item:action.view",
    "approvals:action.view",
  ],

  store: [
    "doc.grn",
    "doc.grn:action.view",
    "doc.grn:action.add",
    "doc.grn:action.edit",
    "doc.grn:action.submit",
    "doc.grn:action.cancel",
    "doc.grn:action.close",
    "doc.grn:action.stage_approve",
    "doc.grn:action.quality_check",
    "doc.grn:action.comment",
    "doc.grn:action.attach",
    "doc.grn:action.print",
    "doc.grn:view.draft",
    "doc.grn:view.waiting_approve",
    "doc.grn:view.approved",
    "doc.grn:view.rejected",
    "doc.store_issue",
    "doc.store_issue:action.view",
    "doc.store_issue:action.add",
    "doc.store_issue:action.edit",
    "doc.store_issue:action.submit",
    "doc.store_issue:action.cancel",
    "doc.store_issue:action.stage_approve",
    "doc.store_return:action.view",
    "doc.store_return:action.add",
    "doc.store_return:action.edit",
    "doc.store_return:action.submit",
    "doc.stock_transfer:action.view",
    "doc.stock_transfer:action.add",
    "doc.stock_transfer:action.submit",
    "stock:action.view",
    "stock:action.view_value",
    "stock:action.reorder",
    "stock:view.available",
    "stock:view.quarantine",
    "master.item:action.view",
    "master.vendor:action.view",
    "reports:action.view",
    "approvals:action.view",
  ],

  lab: [
    "doc.grn",
    "doc.grn:action.view",
    "doc.grn:action.quality_check",
    "doc.grn:action.comment",
    "doc.grn:action.attach",
    "doc.grn:view.waiting_approve",
    "doc.grn:view.approved",
    "master.item:action.view",
    "approvals:action.view",
  ],

  weigh: [
    "doc.grn",
    "doc.grn:action.view",
    "doc.grn:action.add",
    "doc.grn:action.edit",
    "doc.grn:action.submit",
    "doc.grn:action.comment",
    "doc.grn:view.draft",
    "doc.grn:view.waiting_approve",
    "master.item:action.view",
    "approvals:action.view",
  ],

  viewer: [
    "doc.indent:action.view",
    "doc.po:action.view",
    "doc.grn:action.view",
    "doc.vendor_selection:action.view",
    "doc.store_issue:action.view",
    "doc.store_return:action.view",
    "doc.stock_transfer:action.view",
    "doc.stock_adjustment:action.view",
    "doc.stock_count:action.view",
    "doc.rtv:action.view",
    "doc.issue_request:action.view",
    "master.item:action.view",
    "master.vendor:action.view",
    "master.department:action.view",
    "master.uom:action.view",
    "master.payment_terms:action.view",
    "master.tax_code:action.view",
    "master.terms:action.view",
    "master.consumable:action.view",
    "master.raw_material:action.view",
    "stock:action.view",
    "reports:action.view",
    "dashboards:action.view",
  ],
};

async function main() {
  console.log("=== Procure Permission Setup ===\n");

  // Step 1: Login
  console.log("1. Logging in as platform owner...");
  const platformToken = await login();
  console.log("   Platform login OK");

  // Step 2: Impersonate tenant
  console.log("2. Impersonating tenant...");
  const tenantToken = await impersonate(platformToken);
  console.log("   Tenant token acquired");

  // Step 3: Get roles
  console.log("3. Fetching roles...");
  const rolesRaw = await getRoles(tenantToken);
  console.log("   Raw roles response (first item):", JSON.stringify(Array.isArray(rolesRaw) ? rolesRaw[0] : rolesRaw, null, 2));

  // Normalize roles array
  let roles = Array.isArray(rolesRaw) ? rolesRaw : (rolesRaw.items || rolesRaw.data || []);
  console.log(`   Found ${roles.length} roles total`);
  roles.forEach((r) => console.log(`   - key="${r.key}" name="${r.name}" id="${r.id}"`));

  // Step 4: Test with HOD first
  const TARGET_KEYS = Object.keys(ROLE_PERMISSIONS);
  const missing = [];
  const found = [];

  for (const key of TARGET_KEYS) {
    const role = roles.find((r) => r.key === key);
    if (!role) {
      missing.push(key);
    } else {
      found.push({ key, id: role.id, name: role.name });
    }
  }

  console.log(`\n4. Role check:`);
  console.log(`   Found: ${found.map((r) => r.key).join(", ")}`);
  if (missing.length > 0) {
    console.log(`   MISSING (will skip): ${missing.join(", ")}`);
  }

  // Step 5: Apply permissions - test HOD first
  console.log("\n5. Applying permissions...");

  // Test with HOD first
  const hodRole = found.find((r) => r.key === "hod");
  if (hodRole) {
    console.log(`\n   [TEST] Applying HOD permissions first to verify format...`);
    const ok = await setPermissions(tenantToken, hodRole.id, hodRole.name, ROLE_PERMISSIONS["hod"]);
    if (!ok) {
      console.error("   HOD test FAILED - stopping to investigate");
      process.exit(1);
    }
    console.log("   HOD test PASSED - proceeding with all roles");
  }

  // Apply all roles
  const results = { success: [], failed: [], skipped: missing };
  for (const { key, id, name } of found) {
    if (key === "hod") {
      results.success.push(key); // already done
      continue;
    }
    console.log(`\n   Applying [${key}] (${name})...`);
    const ok = await setPermissions(tenantToken, id, name, ROLE_PERMISSIONS[key]);
    if (ok) {
      results.success.push(key);
    } else {
      results.failed.push(key);
    }
  }

  // Summary
  console.log("\n=== SUMMARY ===");
  console.log(`SUCCESS (${results.success.length}): ${results.success.join(", ") || "none"}`);
  console.log(`FAILED  (${results.failed.length}): ${results.failed.join(", ") || "none"}`);
  console.log(`SKIPPED (${results.skipped.length}): ${results.skipped.join(", ") || "none"}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
