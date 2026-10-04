# BancoFlow | Portfolio Demo

Versao demonstrativa e independente de um sistema de banco de horas. Todos os nomes, matriculas, e-mails, equipes, saldos e solicitacoes desta copia sao ficticios.

## Acessos demonstrativos

Senha comum: `Portfolio#2026`

- Administrador: `demo`
- Operador: `ana`
- Supervisor: `carla`

## Executar localmente

```powershell
npm install
$env:DEMO_MODE="true"
npm start
```

Abra `http://localhost:4173`.

## Publicacao

O arquivo `render.yaml` cria um servico gratuito separado, sem Firebase e sem qualquer credencial ou base de dados do sistema original. O armazenamento da demonstracao e efemero e volta aos dados ficticios quando a instancia e recriada.

## Verificacao

```powershell
npm run check
npm test
npm audit --omit=dev
```
