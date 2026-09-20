type BuilderRoleDb = {
  query: (text: string) => Promise<Record<string, unknown>[]>;
};

/** Shared by HQ setup and public submissions; existing operator settings win. */
export async function ensureBuilderRole(db: BuilderRoleDb): Promise<string | null> {
  const [role] = await db.query(`
    INSERT INTO hq_people_roles AS r (label, filter_label, color, bg, is_judge, sort)
    VALUES ('Builder', 'Builders', 'accent', 'accent-fill', false, 100)
    ON CONFLICT (label) DO UPDATE SET label = EXCLUDED.label
    WHERE NOT r.is_judge
    RETURNING id
  `);
  return role ? String(role.id) : null;
}
