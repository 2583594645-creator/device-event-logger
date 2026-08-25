export async function sendBarkNotification(
  barkKey: string,
  title: string,
  body: string,
): Promise<void> {
  const url = `https://api.day.app/${barkKey}/${encodeURIComponent(title)}/${encodeURIComponent(body)}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Bark push failed: ${resp.status}`);
  }
}
