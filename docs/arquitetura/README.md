# Arquitetura

Três vistas do sistema, cada uma numa notação padrão.

| Vista | Notação | Responde |
|---|---|---|
| 1. Casos de uso | UML | Quem usa e para quê |
| 2. Processo | BPMN 2.0 | Como o trabalho anda, com uma raia para cada quem executa |
| 3. Arquitetura | C4, nível 2 | De que partes o sistema é feito e com quem conversa |

## Almoxarifado · estoque de obra por QR Code

MVP de almoxarifado de obra: cada item tem etiqueta com QR, a requisição sai pelo celular, quem recebe confirma com PIN e o saldo é a soma dos movimentos. Feito para um colega mostrar à chefia; encerrado e fora do ar desde 07/09/2026.

### 1. Quem usa e para quê

![Casos de uso de Almoxarifado](./almoxarifado-1-casos-de-uso.svg)

### 2. Da requisição no celular à entrega com PIN

![Processo de Almoxarifado](./almoxarifado-2-processo.svg)

### 3. Arquitetura

![Arquitetura de Almoxarifado](./almoxarifado-3-arquitetura.svg)

Para editar: [almoxarifado.excalidraw](./almoxarifado.excalidraw), que abre em [excalidraw.com](https://excalidraw.com) ou na extensão Excalidraw do VS Code.

## De onde vêm

Os diagramas são gerados a partir do Sinapse, o vault onde o Pedro organiza notas e projetos. Mudança feita direto aqui some na próxima publicação: o lugar de mudar é a especificação no Sinapse.
