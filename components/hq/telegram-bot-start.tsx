import styles from "./telegram-bot-start.module.css";

export function TelegramBotStart({ botUrl }: { botUrl: string | null }) {
  return (
    <div className={styles.notice}>
      <p>To receive updates and reminders, start a chat with the Superteam NL bot and tap <strong>Start</strong>. Keep bot reminders enabled in HQ.</p>
      {botUrl && <a className={styles.link} href={botUrl} target="_blank" rel="noopener noreferrer">Open Telegram bot</a>}
    </div>
  );
}
