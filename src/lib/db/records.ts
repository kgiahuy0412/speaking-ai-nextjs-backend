import { queryDatabase } from "@/lib/db";

type StoredRecordRow = {
  value: unknown;
  revision: string | number;
};

export type RecordListOptions = {
  clientId?: string;
  limit?: number;
  oldestFirst?: boolean;
};

export type StoredRecordEntry<T> = {
  key: string;
  clientId?: string;
  createdAt: string;
  updatedAt: string;
  value: T;
};

export async function putRecord<T>(options: {
  namespace: string;
  key: string;
  value: T;
  clientId?: string;
  createdAt?: string;
  expiresAt?: string;
}) {
  await queryDatabase(
    `INSERT INTO app_records
      (namespace, record_key, client_id, created_at, updated_at, expires_at, value)
     VALUES ($1, $2, $3, COALESCE($4::timestamptz, NOW()), NOW(), $5::timestamptz, $6::jsonb)
     ON CONFLICT (namespace, record_key) DO UPDATE SET
       client_id = EXCLUDED.client_id,
       updated_at = NOW(),
       expires_at = EXCLUDED.expires_at,
       revision = app_records.revision + 1,
       value = EXCLUDED.value`,
    [
      options.namespace,
      options.key,
      options.clientId ?? null,
      options.createdAt ?? null,
      options.expiresAt ?? null,
      JSON.stringify(options.value),
    ],
  );
}

export async function insertRecordIfAbsent<T>(options: {
  namespace: string;
  key: string;
  value: T;
  clientId?: string;
  createdAt?: string;
}) {
  const rows = await queryDatabase<{ record_key: string }>(
    `INSERT INTO app_records
      (namespace, record_key, client_id, created_at, updated_at, value)
     VALUES ($1, $2, $3, COALESCE($4::timestamptz, NOW()), NOW(), $5::jsonb)
     ON CONFLICT (namespace, record_key) DO NOTHING
     RETURNING record_key`,
    [
      options.namespace,
      options.key,
      options.clientId ?? null,
      options.createdAt ?? null,
      JSON.stringify(options.value),
    ],
  );
  return rows.length > 0;
}

export async function getRecord<T>(namespace: string, key: string) {
  const rows = await queryDatabase<StoredRecordRow>(
    `SELECT value, revision
       FROM app_records
      WHERE namespace = $1 AND record_key = $2`,
    [namespace, key],
  );

  return rows[0]
    ? {
        value: rows[0].value as T,
        revision: Number(rows[0].revision),
      }
    : null;
}

export async function listRecords<T>(
  namespace: string,
  options: RecordListOptions = {},
) {
  const params: unknown[] = [namespace];
  const clauses = ["namespace = $1", "(expires_at IS NULL OR expires_at > NOW())"];

  if (options.clientId !== undefined) {
    params.push(options.clientId);
    clauses.push(`client_id = $${params.length}`);
  }

  const limit = Math.max(1, Math.min(options.limit ?? 10_000, 100_000));
  params.push(limit);
  const order = options.oldestFirst ? "ASC" : "DESC";
  const rows = await queryDatabase<{ value: unknown }>(
    `SELECT value
       FROM app_records
      WHERE ${clauses.join(" AND ")}
      ORDER BY created_at ${order}
      LIMIT $${params.length}`,
    params,
  );

  return rows.map((row) => row.value as T);
}

export async function listRecordEntries<T>(
  namespace: string,
  options: RecordListOptions = {},
) {
  const params: unknown[] = [namespace];
  const clauses = ["namespace = $1", "(expires_at IS NULL OR expires_at > NOW())"];

  if (options.clientId !== undefined) {
    params.push(options.clientId);
    clauses.push(`client_id = $${params.length}`);
  }

  const limit = Math.max(1, Math.min(options.limit ?? 10_000, 100_000));
  params.push(limit);
  const order = options.oldestFirst ? "ASC" : "DESC";
  const rows = await queryDatabase<{
    record_key: string;
    client_id: string | null;
    created_at: string | Date;
    updated_at: string | Date;
    value: unknown;
  }>(
    `SELECT record_key, client_id, created_at, updated_at, value
       FROM app_records
      WHERE ${clauses.join(" AND ")}
      ORDER BY created_at ${order}
      LIMIT $${params.length}`,
    params,
  );

  return rows.map(
    (row) =>
      ({
        key: row.record_key,
        clientId: row.client_id ?? undefined,
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString(),
        value: row.value as T,
      }) satisfies StoredRecordEntry<T>,
  );
}

export async function updateRecord<T>(options: {
  namespace: string;
  key: string;
  clientId?: string;
  mutate: (current: T) => T;
}) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await getRecord<T>(options.namespace, options.key);

    if (!current) {
      return null;
    }

    const nextValue = options.mutate(current.value);
    const params: unknown[] = [
      options.namespace,
      options.key,
      current.revision,
      JSON.stringify(nextValue),
    ];
    let clientClause = "";

    if (options.clientId !== undefined) {
      params.push(options.clientId);
      clientClause = ` AND client_id = $${params.length}`;
    }

    const rows = await queryDatabase<{ revision: string | number }>(
      `UPDATE app_records
          SET value = $4::jsonb, revision = revision + 1, updated_at = NOW()
        WHERE namespace = $1 AND record_key = $2 AND revision = $3${clientClause}
        RETURNING revision`,
      params,
    );

    if (rows.length > 0) {
      return nextValue;
    }
  }

  throw new Error("Dữ liệu vừa được cập nhật đồng thời; vui lòng thử lại.");
}

export async function deleteRecord(
  namespace: string,
  key: string,
  clientId?: string,
) {
  const params: unknown[] = [namespace, key];
  const clientClause =
    clientId === undefined
      ? ""
      : ` AND client_id = $${params.push(clientId)}`;
  const rows = await queryDatabase<{ record_key: string }>(
    `DELETE FROM app_records
      WHERE namespace = $1 AND record_key = $2${clientClause}
      RETURNING record_key`,
    params,
  );
  return rows.length > 0;
}

export async function clearRecords(namespace: string, clientId?: string) {
  const params: unknown[] = [namespace];
  const clientClause =
    clientId === undefined
      ? ""
      : ` AND client_id = $${params.push(clientId)}`;
  const rows = await queryDatabase<{ record_key: string }>(
    `DELETE FROM app_records
      WHERE namespace = $1${clientClause}
      RETURNING record_key`,
    params,
  );
  return rows.length;
}

export async function deleteRecordsOlderThan(
  namespace: string,
  cutoff: string,
) {
  const rows = await queryDatabase<{ record_key: string }>(
    `DELETE FROM app_records
      WHERE namespace = $1 AND created_at < $2::timestamptz
      RETURNING record_key`,
    [namespace, cutoff],
  );
  return rows.length;
}

export async function countRecords(namespace: string) {
  const rows = await queryDatabase<{ count: string | number }>(
    `SELECT COUNT(*)::bigint AS count
       FROM app_records
      WHERE namespace = $1`,
    [namespace],
  );
  return Number(rows[0]?.count ?? 0);
}
