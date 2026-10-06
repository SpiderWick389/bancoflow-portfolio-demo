# BancoFlow | Portfolio Demo

Versao demonstrativa e independente de um sistema de banco de horas. Todos os nomes, matriculas, e-mails, equipes, saldos e solicitacoes desta copia sao ficticios.

## Demonstracao online

https://bancoflow-portfolio-demo.onrender.com

O BancoFlow apresenta um fluxo completo de solicitacao e aprovacao, calendario com limite diario, saldos individuais, perfis de acesso, notificacoes e relatorios para Excel em uma interface responsiva.

A base ficticia e restaurada quando um dos acessos demonstrativos entra no sistema e tambem a cada hora. Assim, exclusoes, trocas de senha e testes feitos por um visitante nao quebram a experiencia do proximo.

## Principais recursos

- Fluxos de aprovacao diferentes por perfil.
- Controle de saldo em horas e minutos, incluindo limite negativo.
- Calendario inteligente com ocupacao por data.
- Perfis de administrador, operador, lider, supervisor, coordenador, analista, assistente, monitoramento e ajuste de horas.
- Dashboard responsivo, temas claro e escuro e navegacao mobile.
- Exportacao de solicitacoes e saldos para Excel.
- Dados demonstrativos isolados, sem conexao com sistemas corporativos.

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
