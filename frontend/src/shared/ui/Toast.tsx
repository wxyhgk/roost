export function Toast({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="pointer-events-none fixed bottom-4 left-1/2 z-[110] -translate-x-1/2 rounded-full border border-border bg-bg-raised px-3.5 py-1.5 text-body text-text shadow-pop">
      {message}
    </div>
  );
}
