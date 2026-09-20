import styles from "./telegram-bot-start.module.css";

export function TelegramBotStart({ botUrl, inverse = false }: { botUrl: string | null; inverse?: boolean }) {
  return (
    <div className={`${styles.notice} ${inverse ? styles.inverse : ""}`}>
      <p>To receive updates and reminders, start a chat with the Superteam NL bot and tap <strong>Start</strong>. Keep bot reminders enabled in HQ.</p>
      {botUrl && <a className={styles.link} href={botUrl} target="_blank" rel="noopener noreferrer">Open Telegram bot</a>}
    </div>
  );
}
