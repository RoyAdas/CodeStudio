import { t, tr, useLocale, setLocale } from './i18n';
export async function streamChat(data: any, token: string, signal: AbortSignal, delta: (text: string) => void) {
    const response = await fetch('/api/ai/stream', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Studio-Token': token }, body: JSON.stringify(data), signal });
    if (!response.ok) {
        const result = await response.json();
        throw Error(result.error || t("AI 请求失败"));
    }
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let done = false;
    try {
        while (true) {
            const part = await reader.read();
            buffer += decoder.decode(part.value, { stream: !part.done });
            let end;
            while ((end = buffer.indexOf('\n\n')) >= 0) {
                const frame = buffer.slice(0, end);
                buffer = buffer.slice(end + 2);
                const raw = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
                if (!raw)
                    continue;
                const event = JSON.parse(raw);
                if (event.type === 'delta')
                    delta(event.text);
                if (event.type === 'error')
                    throw Error(event.error);
                if (event.type === 'done')
                    done = true;
            }
            if (part.done)
                break;
        }
        if (!done)
            throw Error(t("AI 连接提前结束，回复可能不完整。"));
    }
    finally {
        await reader.cancel().catch(() => { });
        reader.releaseLock();
    }
}
