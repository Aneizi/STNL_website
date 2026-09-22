import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vitest";
import { loadMigrations, runMigrations } from "@/scripts/hq/migrations";
import { pgliteMigrationConnection } from "./helpers/db";

it("corrects premature Builder tags per edition while preserving successful teams and operator data", async () => {
  const pg = new PGlite();
  try {
    const connection = pgliteMigrationConnection(pg);
    const migrations = loadMigrations();
    await runMigrations(connection, migrations.slice(0, 1));
    await pg.exec(`
      INSERT INTO hq_hackathons(id,slug,name,start_date,end_date) VALUES
        (41,'current','Current','2026-09-14','2026-10-12'),
        (42,'other','Other','2027-01-01','2027-02-01');
      INSERT INTO hq_project_statuses(slug,label,color) VALUES('green','Green','green');
      INSERT INTO hq_project_forecasts(slug,label,color) VALUES('likely','Likely','green');
      INSERT INTO hq_people_roles(label,filter_label,color,bg) VALUES('Mentor','Mentors','green','green-fill');
      INSERT INTO hq_builder_profiles(id,email,name)
        SELECT name,name || '@example.test',name FROM unnest(ARRAY[
          'signup','requester','owner','joined','unclaimed','admin-owner','pending-owner','custom'
        ]) name;
      INSERT INTO hq_builder_enrollments(user_id,hackathon_id)
        SELECT id,41 FROM hq_builder_profiles;
      INSERT INTO hq_builder_enrollments(user_id,hackathon_id) VALUES('owner',42);
      INSERT INTO hq_crm_persons(display_name,builder_user_id)
        SELECT name,id FROM hq_builder_profiles;
      INSERT INTO hq_people(hackathon_id,builder_user_id,name,role_id,person_id,notes,contact)
        SELECT e.hackathon_id,e.user_id,e.user_id,r.id,c.id,'Keep notes','@keep_contact'
        FROM hq_builder_enrollments e JOIN hq_crm_persons c ON c.builder_user_id=e.user_id
        JOIN hq_people_roles r ON r.label=CASE WHEN e.user_id='custom' THEN 'Mentor' ELSE 'Builder' END;
      INSERT INTO hq_people(hackathon_id,name,role_id,notes)
        SELECT 41,'Manual card',id,'Keep manual card' FROM hq_people_roles WHERE label='Builder';
      INSERT INTO hq_project_import_requests(user_id,hackathon_id,project_url,note)
        VALUES('requester',41,'https://colosseum.com/arena/projects/explore/unavailable','Please help');
    `);
    const projects: Record<string, string> = {};
    for (const owner of ["owner", "admin-owner", "pending-owner"]) {
      const { rows: [project] } = await pg.query<{ id: string }>(`INSERT INTO hq_projects(hackathon_id,name,status_id,forecast_id,last_check_in)
        SELECT 41,$1,s.id,f.id,current_date FROM hq_project_statuses s CROSS JOIN hq_project_forecasts f RETURNING id`, [owner]);
      projects[owner] = project.id;
      await pg.query(`INSERT INTO hq_project_ownership(project_id,hackathon_id,owner_user_id,source) VALUES($1,41,$2,$3)`,
        [project.id, owner, owner === "admin-owner" ? "admin" : "import"]);
      if (owner !== "admin-owner") {
        await pg.query(`INSERT INTO hq_project_onboarding(project_id,hackathon_id,external_id,project_url,slug,country,raw,owner_user_id,lead_username,verification)
          VALUES($1,41,$2,'https://colosseum.com/arena/projects/explore/team',$3,'Netherlands','{}',$3,$3,$4)`,
          [project.id, owner === "owner" ? 1 : 2, owner, owner === "owner" ? "verified" : "pending"]);
      }
    }
    await pg.query(`INSERT INTO hq_project_members(project_id,name,colosseum_username,builder_user_id,joined_at)
      VALUES($1,'Joined','joined','joined',now())`, [projects.owner]);
    // A source/CRM match alone is not a completed join.
    await pg.query(`INSERT INTO hq_project_members(project_id,name,colosseum_username,person_id)
      SELECT $1,'Unclaimed','unclaimed',id FROM hq_crm_persons WHERE builder_user_id='unclaimed'`, [projects.owner]);

    const peopleData = async () => (await pg.query("SELECT id,hackathon_id,builder_user_id,person_id,name,notes,contact FROM hq_people ORDER BY id")).rows;
    const accounts = async () => (await pg.query("SELECT * FROM hq_builder_profiles ORDER BY id")).rows;
    const teams = async () => (await pg.query("SELECT * FROM hq_project_ownership ORDER BY project_id")).rows;
    const before = { people: await peopleData(), accounts: await accounts(), teams: await teams() };
    expect(await runMigrations(connection, migrations)).toEqual(["0002-builder-role-after-team-setup"]);
    expect((await pg.query(`SELECT p.name,p.hackathon_id,r.label,e.participation FROM hq_people p
      JOIN hq_people_roles r ON r.id=p.role_id
      LEFT JOIN hq_builder_enrollments e ON e.user_id=p.builder_user_id AND e.hackathon_id=p.hackathon_id
      ORDER BY p.name,p.hackathon_id`)).rows).toEqual([
      { name: "Manual card", hackathon_id: 41, label: "Builder", participation: null },
      { name: "admin-owner", hackathon_id: 41, label: "Builder", participation: "builder" },
      { name: "custom", hackathon_id: 41, label: "Mentor", participation: "builder" },
      { name: "joined", hackathon_id: 41, label: "Builder", participation: "builder" },
      { name: "owner", hackathon_id: 41, label: "Builder", participation: "builder" },
      { name: "owner", hackathon_id: 42, label: "User", participation: "supporter" },
      { name: "pending-owner", hackathon_id: 41, label: "User", participation: "supporter" },
      { name: "requester", hackathon_id: 41, label: "User", participation: "supporter" },
      { name: "signup", hackathon_id: 41, label: "User", participation: "supporter" },
      { name: "unclaimed", hackathon_id: 41, label: "User", participation: "supporter" },
    ]);
    expect({ people: await peopleData(), accounts: await accounts(), teams: await teams() }).toEqual(before);
    expect(await runMigrations(connection, migrations)).toEqual([]);
  } finally {
    await pg.close();
  }
}, 30_000);
