# Cadastro por foto com fonte verificável

A foto fornece pistas. A identificação final exige pesquisa web real, consulta da página, evidências por campo e confirmação do operador. A interface desktop/mobile e os fluxos de login, acesso comercial, OAuth, pedidos e publicação existentes foram preservados.

## Configuração de produção e preview

Configure somente no backend, em Vercel → projeto ANV → Settings → Environment Variables:

- `ANV_OPENAI_API_KEY`: chave da API OpenAI com acesso a Responses API, visão e `web_search`. `OPENAI_API_KEY` também é aceito em Vercel. O alias ANV é adequado às configurações da nuvem que reservam nomes `OPENAI_*`.
- `SUPABASE_URL` e `SUPABASE_SECRET_KEY` (ou a chave existente `SUPABASE_SERVICE_ROLE_KEY`): reutilizar o projeto ANV.
- Reutilizar `ANV_LOGIN_EMAIL`, `ANV_LOGIN_PASSWORD` e `APP_SESSION_SECRET` existentes, incluindo no preview autorizado. Não gerar ou substituir credenciais de produção.
- `ANV_RESEARCH_MODEL` é opcional; padrão `gpt-4.1-mini`, com visão e pesquisa web suportadas. Não escolher um modelo sem as duas capacidades.
- `AI_GATEWAY_API_KEY`/OIDC existentes continuam disponíveis para extração de pistas pelo endpoint antigo; esse fallback não identifica nem importa sozinho o produto final.

Aplicar `supabase/003_anv_product_research.sql` após 001/002 no SQL Editor do projeto ANV. Alternativamente, com `ANV_SUPABASE_ACCESS_TOKEN` e `SUPABASE_URL` seguros, executar `node scripts/apply-research-migration.mjs`. O token de gerenciamento é necessário apenas para aplicar SQL; não é usado pela aplicação. Uma chave REST Supabase não concede capacidade de aplicar migrações.

Para deploy pelo agente, é necessário `VERCEL_TOKEN` com acesso ao projeto/equipe existentes. Também pode existir deploy automático GitHub→Vercel; um push não comprova deploy nem fornece um preview verificado. Não publicar em produção antes do teste real exigido pelo usuário.

Nenhuma chave é enviada ao navegador. Na nuvem, configurar os valores sensíveis em armazenamento seguro; segredos usados para assinar sessão ou verificar senha precisam de valores reais em processo, não de placeholders de proxy. Saídas de diagnóstico nunca devem mostrar valores.

## Comportamento

1. Selecionar JPEG, PNG ou WebP. A foto enviada é redimensionada, se necessário, para transporte; não são inventadas características físicas.
2. Clicar em **PESQUISAR PRODUTO**. A pesquisa é feita no servidor com múltiplas combinações das pistas legíveis, usando `web_search`. URLs apenas citadas no texto do modelo, sem origem na ferramenta de busca, são descartadas.
3. As páginas são consultadas via HTTPS com validação de destino público, DNS fixado por conexão, limite de tamanho, redirecionamentos e tempo. Sites que bloqueiam leitura não são tratados como fontes verificadas. Não há bypass de TLS ou de acesso.
4. Cada campo exige valor e trecho literal encontrados no conteúdo da página. Preço/estoque não são importados. Dimensões e peso do produto ficam como especificações; não são convertidos indevidamente em medidas de embalagem.
5. Correspondência é um **índice heurístico de evidências, não uma probabilidade estatística**. Aparência sem código exato fica abaixo de 80. Código, marca/modelo, imagem de referência e conflitos compõem a pontuação. Acima de 95 exige comparação por imagem; conflito limita a pontuação abaixo de 80. O operador sempre confirma, inclusive em resultados acima de 95.
6. Até três referências são exibidas, com prioridade de fabricante/oficial/autorizado quando essa classificação tem prova na página. O backend consulta novamente a fonte selecionada antes de importar; mudanças incompatíveis exigem nova pesquisa.
7. Revisar e editar campos. Clicar **SALVAR PRODUTO** salva produto, foto e vínculo da pesquisa em uma transação idempotente. Fonte, campos importados, trechos, candidatos, buscas, pontuação e histórico ficam na tabela privada `anv_product_research`. Dados revisados do produto e dados originais da fonte permanecem distintos para auditoria.
8. O fluxo existente prepara o anúncio, consulta categoria/atributos do Mercado Livre e valida publicação. A categoria da fonte não é presumida como ID do Mercado Livre. A pesquisa não publica automaticamente nem cria preço/estoque.

Resultados abaixo de 80 pedem etiqueta/código/outro ângulo; **USAR ESTE PRODUTO** fica desabilitado. O cadastro manual continua disponível explicitamente. Trocar a foto ou abrir um novo cadastro invalida resultados anteriores; respostas atrasadas não preenchem o novo formulário.

Imagens externas são apenas referências de identificação, sem cópia automática para anúncio ou presunção de direitos de uso. Os recursos existentes de capa/ficha técnica usam a foto do usuário e dados revisados; não inventam novas vistas físicas do produto.

## Validação

- `npm ci --ignore-scripts` e `npm test`: contratos da API de IA, limites de correspondência, evidência literal, URLs, segurança e execução das migrações 001/002/003 em PostgreSQL embarcado real (PGlite). Os dados isolados desses testes são vetores de teste; não são demonstrações de identificação comercial.
- Com o servidor local preparado e Chromium instalado: `npm run test:browser`. A regressão de desktop/mobile usa as interfaces reais, sem respostas HTTP simuladas; verifica seleção de arquivo, pesquisa explícita, recusa real por falta de sessão, cadastro manual, preço/estoque preservados e reset do formulário. Não substitui teste autenticado com produto real.
- Após disponibilizar credenciais e migração, usar uma foto real de peça, confirmar pistas, buscas executadas, fontes que abrem, correspondência física/código, score, importação, salvamento, edição e preflight real do Mercado Livre. Testar publicação apenas no destino autorizado. Não considerar a função entregue em produção sem essas evidências.

Na validação desta máquina não havia chave de IA, sessão autenticada, acesso ao Supabase ou token Vercel. Nenhum produto, fonte ou score real foi declarado como encontrado. Migração em Supabase remoto, busca real, preflight/publicação no Mercado Livre e preview remoto permanecem dependentes do acesso externo.
