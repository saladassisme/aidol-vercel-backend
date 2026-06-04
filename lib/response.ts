import { NextResponse } from 'next/server';

export function ok(data: unknown, init?: ResponseInit) {
  return NextResponse.json({ ok: true, data }, init);
}

export function fail(message: string, status = 400, code = 'BAD_REQUEST', details?: unknown) {
  return NextResponse.json({ ok: false, error: { code, message, details } }, { status });
}
