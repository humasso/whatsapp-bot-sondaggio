# whatsapp-bot-sondaggio

Bot Node.js che resta collegato a WhatsApp Web via Baileys, monitora un gruppo
preciso e vota automaticamente appena vede un nuovo sondaggio.

> Nota: Baileys usa WhatsApp Web in modo non ufficiale. Usa il bot solo con un
> account e in gruppi dove hai autorizzazione.

## Requisiti

- Node.js 20 o superiore
- Un account WhatsApp da collegare come dispositivo

## Installazione

```bash
npm install
cp .env.example .env
```

Poi modifica `.env`.

Puoi indicare il gruppo in due modi:

- `TARGET_GROUP_JID`: consigliato, termina con `@g.us`
- `TARGET_GROUP_NAME`: usa il nome esatto del gruppo; se ci sono duplicati il bot
  stampa un errore e chiede il JID

Per scegliere cosa cliccare nel sondaggio:

- `POLL_OPTION_INDEX=0` vota la prima opzione
- `POLL_OPTION_TEXT=Testo esatto` vota l'opzione con quel testo e ha priorita'
  sull'indice

## Avvio

```bash
npm start
```

Al primo avvio comparira' un QR nel terminale. Apri WhatsApp sul telefono:

1. Impostazioni
2. Dispositivi collegati
3. Collega un dispositivo
4. Scansiona il QR

La sessione resta salvata in `.session/`.

## Test senza votare

Prima di usarlo davvero puoi impostare:

```env
DRY_RUN=true
```

Il bot rilevera' i sondaggi e stampera' l'opzione scelta, ma non inviera' il
voto.
