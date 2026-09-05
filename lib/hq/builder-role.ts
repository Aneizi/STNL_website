type BuilderRoleDb = {
  query: (text: string) => Promise<Record<string, unknown>[]>;
};

/** Shared by HQ setup and public submissions; existing operator settings win. */
export async function ensureBuilderRole(db: BuilderRoleDb): Promise<string | null> {
  await db.query(`
    INSERT INTO hq_people_roles (label, filter_label, color, bg, is_judge, sort)
    VALUES ('Builder', 'Builders', 'accent', 'accent-fill', false, 100)
    ON CONFLICT (label) DO NOTHING
  `);
  const [role] = await db.query(`
    SELECT id FROM hq_people_roles WHERE label = 'Builder' AND NOT is_judge
  `);
  return role ? String(role.id) : null;
}
