import { BuilderShell } from "@/components/hq/builder-shell";
import styles from "@/components/hq/builder-captain-den.module.css";

/** The Den's shell while its page loads: the ink aside and the cream column, with one status line where the team's name will be. */
export default function Loading() {
  return (
    <BuilderShell bare>
      <div className={styles.shell}>
        <aside className={styles.aside} aria-hidden="true" />
        <div className={styles.main}><p role="status" aria-live="polite" className={styles.empty}>Opening the Captains&apos; Den…</p></div>
      </div>
    </BuilderShell>
  );
}
