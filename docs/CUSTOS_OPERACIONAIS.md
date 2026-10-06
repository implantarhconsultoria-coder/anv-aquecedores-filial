# ANV FILIAL DIGITAL — CONTROLE DE CUSTOS

Este documento é a referência oficial para qualquer custo do projeto ANV Filial Digital.

## Regra obrigatória

Nenhum novo custo recorrente ou pontual deve ser considerado aprovado sem registro prévio contendo:

- fornecedor/serviço;
- finalidade;
- moeda original;
- valor original;
- periodicidade;
- estimativa em reais;
- cotação USD/BRL utilizada na estimativa;
- data da cotação;
- taxas adicionais conhecidas, incluindo impostos, IOF, spread cambial ou tarifa do cartão/provedor quando aplicável;
- observação de que o valor final em reais pode variar por câmbio, data de fechamento, impostos e regras do meio de pagamento.

## Relatório mensal

Gerar relatório mensal consolidado dos custos do ANV contendo, no mínimo:

| Serviço | Finalidade | Valor original | Periodicidade | Cotação USD/BRL | Estimativa em R$ | Taxas/Impostos | Status |
|---|---|---:|---|---:|---:|---|---|

O relatório deve separar:

1. custos fixos recorrentes;
2. custos variáveis/uso;
3. custos pontuais do mês;
4. total em moeda original;
5. total estimado em reais;
6. comparação com o mês anterior quando houver histórico;
7. novos custos adicionados no período;
8. custos cancelados ou reduzidos;
9. itens que exigem decisão do responsável.

## Regra cambial

Quando houver cobrança em dólar:

- manter sempre o valor principal em USD;
- converter para BRL apenas como estimativa;
- registrar a cotação usada e a data da cotação;
- destacar: **"Valor em reais estimado. O valor efetivamente cobrado pode variar conforme câmbio, IOF, spread do cartão/provedor e data de processamento/fechamento."**

## Custos ativos

### Supabase — ANV Filial Digital

- Serviço: Supabase — projeto exclusivo ANV Filial Digital
- Finalidade: banco de dados/backend operacional exclusivo do ANV
- Região: `sa-east-1`
- Status operacional: **ACTIVE_HEALTHY**
- Valor informado pelo provedor na criação: **US$ 10/mês**
- Periodicidade: mensal
- Cotação de referência em 06/10/2026: **US$ 1 = R$ 4,9943**
- Estimativa em reais na data de referência: **R$ 49,94/mês**
- Taxas/Impostos: não incluídos nesta estimativa; podem existir IOF, spread cambial e/ou tarifa do meio de pagamento.
- Observação obrigatória: **Valor em reais estimado. O valor efetivamente cobrado pode variar conforme câmbio, IOF, spread do cartão/provedor e data de processamento/fechamento.**

## Governança

Antes de contratar qualquer novo serviço pago para o ANV, registrar este custo aqui e informar o responsável. Custos novos devem aparecer automaticamente no relatório mensal seguinte.
