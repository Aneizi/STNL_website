import { BuilderShell } from "@/components/hq/builder-shell";
import styles from "./account-passport.module.css";

export default function Loading() {
  return <BuilderShell bare><div className={styles.main}><p role="status" aria-live="polite">Opening your account…</p></div></BuilderShell>;
}
