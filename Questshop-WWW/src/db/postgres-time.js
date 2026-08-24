export async function databaseClock(client) {
  return (await client.query('SELECT clock_timestamp() AS now')).rows[0].now;
}

export async function bangkokDayBounds(client, instant = null) {
  const result = await client.query(`
    SELECT
      date_trunc('day', COALESCE($1::timestamptz, clock_timestamp()) AT TIME ZONE 'Asia/Bangkok')
        AT TIME ZONE 'Asia/Bangkok' AS starts_at,
      (date_trunc('day', COALESCE($1::timestamptz, clock_timestamp()) AT TIME ZONE 'Asia/Bangkok')
        + interval '1 day') AT TIME ZONE 'Asia/Bangkok' AS ends_at,
      to_char(COALESCE($1::timestamptz, clock_timestamp()) AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD') AS bangkok_day
  `, [instant]);
  return result.rows[0];
}
