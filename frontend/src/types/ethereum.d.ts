import type { Eip1193Provider } from "ethers";

/**
 * The object MetaMask (and most other injected wallets) attaches to
 * `window.ethereum`. It's a valid ethers `Eip1193Provider` plus the
 * non-standard-but-universally-supported event emitter methods dApps use to
 * react to account/network switches without a page reload.
 */
interface InjectedEthereumProvider extends Eip1193Provider {
  isMetaMask?: boolean;
  on?(eventName: "accountsChanged" | "chainChanged" | string, listener: (...args: any[]) => void): void;
  removeListener?(eventName: "accountsChanged" | "chainChanged" | string, listener: (...args: any[]) => void): void;
}

declare global {
  interface Window {
    ethereum?: InjectedEthereumProvider;
  }
}

export {};
