export function Toast({
  message,
  visible,
}: {
  message: string;
  visible: boolean;
}) {
  return <div className={`toast${visible ? " show" : ""}`}>{message}</div>;
}

export function Spinner() {
  return (
    <div className="loading">
      <div className="spinner" />
      <p>Жүктелуде...</p>
    </div>
  );
}
