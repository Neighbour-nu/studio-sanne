# Studio Sanne

Website met eenvoudige beheeromgeving voor [studiosanne.online](https://studiosanne.online).

- Site: `/`
- Beheer: `/beheer` (wachtwoord staat in `.env` op de server)
- Alle foto's en teksten staan in de map `data/` (niet in git). Maak daar back-ups van met `./backup.sh`.

## Installeren op de server

```bash
git clone https://github.com/Neighbour-nu/studio-sanne.git
cd studio-sanne
./installeer.sh
```

## Bijwerken

```bash
cd ~/studio-sanne
git pull
./bijwerken.sh
```
