-- Signing in and requesting import help used to assign Builder immediately.
-- Keep those accounts visible without a role tag until they initialize a team. Preserve
-- hand-entered cards, custom roles, account data, notes and Captain grants.
INSERT INTO hq_people_roles (label, filter_label, color, bg, is_judge, sort)
VALUES ('User', 'Users', 'label-2', 'fill-4', false, 101)
ON CONFLICT (label) DO NOTHING;

WITH corrected AS (
  UPDATE hq_people person
  SET role_id = (SELECT id FROM hq_people_roles WHERE label = 'User')
  WHERE person.builder_user_id IS NOT NULL
    AND person.role_id IN (SELECT id FROM hq_people_roles WHERE label = 'Builder' AND NOT is_judge)
    AND NOT EXISTS (
      SELECT 1 FROM hq_projects project
      LEFT JOIN hq_project_onboarding source ON source.project_id = project.id
      LEFT JOIN hq_project_ownership owner ON owner.project_id = project.id
      WHERE project.hackathon_id = person.hackathon_id
        AND (
          (owner.owner_user_id = person.builder_user_id AND owner.source = 'admin')
          OR (source.verification = 'verified' AND (
            source.owner_user_id = person.builder_user_id
            OR owner.owner_user_id = person.builder_user_id
            OR EXISTS (
              SELECT 1 FROM hq_project_members member
              WHERE member.project_id = project.id AND member.builder_user_id = person.builder_user_id
            )
          ))
        )
    )
  RETURNING person.builder_user_id, person.hackathon_id
)
UPDATE hq_builder_enrollments enrollment
SET participation = 'supporter'
FROM corrected
WHERE enrollment.user_id = corrected.builder_user_id
  AND enrollment.hackathon_id = corrected.hackathon_id
  AND enrollment.participation = 'builder';
