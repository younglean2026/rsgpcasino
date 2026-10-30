// ─────────────────────────────────────────────────────────────
//  CONFIGURAÇÃO DO SITE — edite aqui depois do deploy
// ─────────────────────────────────────────────────────────────
export const CONFIG = {
  // "base" para produção, "baseSepolia" para testar com ETH de testnet
  NETWORK: "base",

  // Endereço do RSGPCasino que o script de deploy imprimiu
  CASINO_ADDRESS: "0xD0f171F336a72E898Ef441FbE309A6C40cD39Fc2",

  // Token apostado. Na Base é o $RSGP oficial. Na testnet, use o MockRSGP que o deploy criou.
  TOKEN_ADDRESS: "0x44B63aF715D5ef02CC3646a6CE96875e11d69E85",

  // RPC para leitura. Vazio = RPC público da Base (funciona, mas pode limitar).
  // Para produção, crie um grátis na Alchemy/QuickNode e cole aqui.
  RPC_URL: "",

  // Nomes dos dois lados (troque à vontade, o contrato só conhece 0 e 1)
  SIDES: [
    { name: "CITIZEN", tagline: "the people below", className: "side-0" },
    { name: "VICEROYS", tagline: "the crown above", className: "side-1" },
  ],

  // Quantas apostas recentes o site carrega
  GAMES_TO_LOAD: 200,

  // Folga na taxa do VRF (o excesso volta pra carteira na mesma transação)
  VRF_FEE_BUFFER: 1.5,

  // Valores rápidos no formulário
  QUICK_AMOUNTS: [1000, 10000, 50000, 100000],
};
