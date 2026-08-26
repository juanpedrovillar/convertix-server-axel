# Convertix — Axel Guzmán

Servidor de conversiones para Axel Guzmán. Independiente: no comparte codigo,
base de datos ni configuracion con ningun otro cliente.

## Que hace

1. Recibe mensajes de WhatsApp por webhook de Evolution API (instancia `axel`)
2. Cuando alguien escribe desde la landing con la keyword, registra el contacto
3. Si manda un comprobante (transferencia ARS o PayPal USD), Claude Vision lo analiza
4. Si el pago es valido: lo guarda en Postgres y dispara `Purchase` a Meta CAPI
5. Dashboard en tiempo real con ventas y contactos

## Rutas

| Ruta | Que es |
|---|---|
| `/dashboard.html` | Panel de control |
| `/landing` | Landing de Axel |
| `/api/status` | Estado del servidor |
| `/api/contactos` | Listado de contactos |
| `/api/contactos/export.xlsx` | Descarga de contactos en Excel |
| `/webhook` | Webhook de Evolution API |
| `/api/qr` | QR para vincular WhatsApp |

## Configuracion

Ver `.env.example`. Todo lo especifico del cliente sale de variables de entorno y
los valores por defecto ya son los de Axel, asi que arranca sin configurar nada
salvo las credenciales (`ANTHROPIC_API_KEY`, `META_CAPI_TOKEN`, `DATABASE_URL`,
`EVOLUTION_APIKEY`).
