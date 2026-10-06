# ANV FILIAL DIGITAL — ESCOPO MESTRE OFICIAL

> Este documento é a referência principal do produto. Novas implementações devem preservar o layout e os fluxos existentes que já funcionam e evoluir a base atual sem reconstrução desnecessária.

## 1. Regra de produto

- O layout atual aprovado desta aplicação (`anv-aquecedores-filial`) fica preservado como referência visual oficial.
- Não refazer o sistema do zero.
- A plataforma ANV deve concentrar cadastro, inteligência de produto, preparação/publicação de anúncio, estoque, pedidos, alertas e operação pós-venda.
- O objetivo é reduzir o trabalho manual ao mínimo: o operador informa/cadastra o produto, revisa o que a IA preparou e aperta **Publicar no Mercado Livre**.

## 2. Estratégia comercial inicial

Fase inicial focada em itens menores de instalação, manutenção e reposição ligados a aquecedores e sistemas correlatos, como mangueiras, flexíveis, conexões, peças, acessórios e kits.

- Não priorizar aquecedores completos no início.
- Motivo: começar por produtos menores, com operação e tributação potencialmente mais simples, menor risco financeiro por SKU e maior flexibilidade para competir em preço.
- A plataforma deve permitir ampliar posteriormente para aquecedores e outros equipamentos sem mudar a arquitetura central.

## 3. Cadastro inteligente do produto

O ANV deve aceitar o produto a partir de cadastro manual, foto, arquivo, catálogo ou importação.

A IA deve identificar/preencher, sempre que houver evidência:
- código/SKU;
- nome;
- marca;
- modelo;
- categoria;
- aplicação/compatibilidade;
- material;
- cor/acabamento;
- medidas/dimensões;
- peso;
- tipo de gás quando aplicável;
- voltagem quando aplicável;
- ficha técnica;
- custo;
- preço sugerido;
- estoque;
- estoque mínimo;
- demais atributos exigidos pela categoria do Mercado Livre.

A IA não deve inventar dados ausentes. Campos obrigatórios sem evidência devem ser sinalizados para conferência humana.

## 4. Inteligência de mercado antes de publicar

Para cada produto, o ANV deve apoiar a preparação do anúncio considerando:
- categoria correta no Mercado Livre;
- atributos obrigatórios e recomendados;
- padrão de títulos dos melhores anúncios comparáveis;
- faixa de preços observada;
- qualidade/padrão de imagens;
- descrição e informações técnicas relevantes;
- condições de frete/envio quando disponíveis pela integração;
- oportunidades de diferenciação sem copiar conteúdo de terceiros.

O sistema deve sugerir preço, mas a decisão final de preço continua com o operador.

## 5. Geração automática do anúncio

A partir do produto cadastrado, o ANV deve preparar automaticamente o anúncio completo:

- título otimizado;
- categoria;
- atributos;
- descrição;
- ficha técnica;
- medidas;
- peso;
- SKU/código;
- preço;
- estoque disponível;
- imagens;
- dados necessários para publicação na API oficial do Mercado Livre.

Antes de publicar, executar **preflight** e mostrar somente pendências reais.

Estado desejado:
**PRODUTO → PREPARAR COM IA → PREFLIGHT → PRONTO PARA PUBLICAR → PUBLICAR**

## 6. Imagens do anúncio

A plataforma deve trabalhar com uma foto original do produto e preparar um conjunto completo para o anúncio.

Requisito mínimo desejado:
- capa principal limpa e comercial;
- no mínimo 4 imagens adicionais fora da capa;
- última imagem com especificações técnicas/resumo visual;
- manter fidelidade ao produto real;
- não alterar marca, formato, conexão, cor ou característica física de maneira enganosa;
- gerar imagens no padrão adequado ao marketplace;
- permitir revisão/substituição antes da publicação.

## 7. Publicação com um clique

Depois que o ANV preparar e validar o anúncio, o operador deve ter uma ação principal:

**PUBLICAR NO MERCADO LIVRE**

Ao confirmar:
- publicar pela API oficial;
- guardar `item_id`/identificador do anúncio;
- guardar permalink quando disponível;
- registrar data/hora/usuário;
- vincular permanentemente anúncio ↔ produto ANV;
- mostrar status da publicação dentro do ANV.

Não exigir que o operador monte novamente o anúncio dentro do painel do Mercado Livre.

## 8. Integração Mercado Livre

Integração oficial via OAuth 2.0/PKCE e APIs oficiais.

Fluxos obrigatórios:
- conectar conta oficial;
- renovar token automaticamente;
- detectar se a conta usa modelo Legacy ou User Products;
- publicar anúncio;
- consultar/atualizar anúncio;
- receber notificações/webhooks;
- receber pedidos;
- vincular item vendido ao produto ANV;
- sincronizar estoque;
- tratar cancelamento/estorno de forma idempotente;
- consultar status necessário para operação e pós-venda.

## 9. Pedido e estoque

Exemplo desejado:
- estoque ANV: 10 unidades;
- produto publicado com estoque correspondente;
- vende 1 no Mercado Livre;
- ANV recebe o evento;
- pedido aparece no ANV;
- estoque ANV passa para 9;
- baixa não pode ocorrer duas vezes se o webhook repetir;
- cancelamento devolve o estoque uma única vez quando aplicável.

O ANV é a referência operacional do estoque interno e deve manter histórico auditável de todas as movimentações.

## 10. Estoque mínimo e reposição

Cada SKU deve ter estoque mínimo configurável.

A plataforma deve gerar alertas progressivos conforme giro e saldo. Exemplo:
- produto de boa saída;
- ao chegar em 5 unidades, sinalizar necessidade de compra/reposição;
- alertas devem aparecer no dashboard e alimentar notificações.

No futuro, a recomendação de reposição pode considerar velocidade real de vendas por SKU.

## 11. Notificações

Venda nova deve gerar notificação imediata dentro do ANV e, quando o canal estiver configurado, notificação no celular.

Prioridades:
- nova venda;
- pedido aguardando separação;
- prazo de postagem se aproximando;
- problema de vínculo entre item ML e produto ANV;
- estoque crítico;
- falha de sincronização/publicação.

A notificação deve levar diretamente para o pedido/produto relacionado.

## 12. Fluxo de expedição

Status operacional interno sugerido:

**NOVO → SEPARAR → EMBALAR → PRONTO PARA ENVIO → DESPACHADO → CONCLUÍDO**

O ANV deve refletir os dados do Mercado Livre sempre que a API disponibilizar atualização automática de envio.

Quando a transportadora/coleta/postagem atualizar o evento no Mercado Livre, o ANV deve sincronizar o status sem exigir baixa manual duplicada.

## 13. Nota fiscal / fiscal

O ANV deve prever desde a arquitetura:
- dados fiscais necessários do produto;
- dados fiscais do pedido;
- número/chave/status da nota quando disponível;
- integração futura ou direta com emissor fiscal/ERP compatível;
- vínculo da nota com o pedido.

A obrigação e o fluxo concreto de emissão dependem do regime tributário, UF, natureza da operação e configuração fiscal da empresa, portanto não hardcodar regra tributária sem validação contábil/fiscal.

## 14. Regra de qualidade

Não considerar o módulo de anúncio concluído apenas porque existe uma tela.

Para estar concluído deve, em ambiente real ou homologável:
1. autenticar na conta Mercado Livre;
2. carregar categoria e atributos reais;
3. montar anúncio a partir do produto ANV;
4. executar preflight;
5. publicar via API;
6. salvar o vínculo do item;
7. receber pedido daquele item;
8. baixar estoque uma vez;
9. tratar cancelamento/estorno;
10. exibir tudo corretamente no ANV.

## 15. Princípio central

A experiência desejada é:

**CADASTRE O PRODUTO → IA PREPARA → VOCÊ REVISA → PUBLICAR NO MERCADO LIVRE → ANV ACOMPANHA VENDA, ESTOQUE E OPERAÇÃO.**

Qualquer implementação futura deve proteger esse fluxo e evitar adicionar etapas manuais desnecessárias.