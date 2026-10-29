# Arquitetura

Diagramas gerados a partir do Sinapse (o segundo cérebro do Pedro). Cada projeto tem três vistas,
cada uma numa notação padrão:

1. **Quem usa e para quê**: UML, diagrama de casos de uso.
2. **O processo principal**: BPMN 2.0, com raias por quem executa.
3. **A arquitetura**: modelo C4, nível 2 (containers).

## Almoxarifado · estoque de obra por QR Code

MVP de almoxarifado de obra: cada item tem etiqueta com QR, a requisição sai pelo celular, quem recebe confirma com PIN e o saldo é a soma dos movimentos. Feito para um colega mostrar à chefia; encerrado e fora do ar desde 07/09/2026.

![Almoxarifado · estoque de obra por QR Code](./almoxarifado.svg)

Editável: [`almoxarifado.excalidraw`](./almoxarifado.excalidraw), abre em [excalidraw.com](https://excalidraw.com) ou no VS Code com a extensão Excalidraw.

A fonte destes arquivos é o vault do Sinapse (`09-DESENHOS/`); alterações feitas aqui são sobrescritas na próxima publicação.
