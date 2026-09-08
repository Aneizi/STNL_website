import styles from "./interest.module.css";

export function InterestConfirmation() {
  return (
    <div className={styles.saved}>
      <h2>You&apos;re on the list.</h2>
      <p>Superteam NL has your interest. We&apos;ll contact you about the hackathon using the details you shared.</p>
    </div>
  );
}
