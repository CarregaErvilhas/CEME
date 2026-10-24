#!/usr/bin/env python3
"""Converte o xlsx "Perfis de Perdas E-REDES" (https://www.e-redes.pt/pt-pt/perfis-de-perdas-2026)
no JSON que o motor lê (backend/src/engine/losses-<ano>.json).

O ficheiro tem um perfil "simples" por nível de tensão e por quarto de hora
(hora local de Lisboa, rótulo = fim do intervalo). As perdas que o cliente
paga são em cascata, de cima para baixo:

    BT = (1+BT)(1+MT)(1+AT)(1+AT/RNT) - 1
    MT =        (1+MT)(1+AT)(1+AT/RNT) - 1

(confere com o valor publicado: 2026-10-23 23:30 BT = 0,1484981).

Uso: python3 scripts/etl-perdas.py Perfis_Perdas_E-REDES_2026..xlsx 2026
"""
import json, re, sys, zipfile
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

path, year = sys.argv[1], int(sys.argv[2])
LIS = ZoneInfo('Europe/Lisbon')
z = zipfile.ZipFile(path)
ss = [re.sub(r'<[^>]+>', '', s) for s in re.findall(r'(?s)<si>(.*?)</si>', z.read('xl/sharedStrings.xml').decode())]
sheet = z.read('xl/worksheets/sheet1.xml').decode()

rows = []
for r in re.findall(r'(?s)<row [^>]*>(.*?)</row>', sheet):
    c = {}
    for m in re.finditer(r'<c r="([A-Z]+)\d+"([^>]*?)(?:/>|>(.*?)</c>)', r, re.S):
        col, attr, body = m.groups()
        v = re.search(r'<v>(.*?)</v>', body or '')
        v = v.group(1) if v else ''
        if 't="s"' in attr and v:
            v = ss[int(v)]
        c[col] = v
    if c.get('B', '').isdigit():
        rows.append(c)

year_start = datetime(year, 1, 1, tzinfo=timezone.utc)  # Lisboa = UTC a 1 de janeiro
bt, mt = [], []
cur_day, i, day_start = None, 0, None
for r in rows:
    if r['B'] != cur_day:
        cur_day, i = r['B'], 0
        d = datetime(1899, 12, 30) + timedelta(days=int(r['B']))
        day_start = datetime(d.year, d.month, d.day, tzinfo=LIS).astimezone(timezone.utc)
    idx = int((day_start - year_start).total_seconds() // 900) + i
    assert idx == len(bt), f'quarto fora de ordem em {r["B"]} #{i}: {idx} != {len(bt)}'
    e, f, g, h = (float(r[k]) for k in 'EFGH')
    bt.append(round((1 + e) * (1 + f) * (1 + g) * (1 + h) - 1, 7))
    mt.append(round((1 + f) * (1 + g) * (1 + h) - 1, 7))
    i += 1

end = datetime(year + 1, 1, 1, tzinfo=timezone.utc)
assert len(bt) == int((end - year_start).total_seconds() // 900), len(bt)
out = f'backend/src/engine/losses-{year}.json'
json.dump({'year': year, 'start': year_start.isoformat().replace('+00:00', 'Z'), 'stepMin': 15,
           'source': 'E-REDES Perfis de Perdas ' + str(year), 'BT': bt, 'MT': mt},
          open(out, 'w'), separators=(',', ':'))
print(out, len(bt), 'quartos; media BT', sum(bt) / len(bt), 'MT', sum(mt) / len(mt))
