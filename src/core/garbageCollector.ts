import {formatEther, formatUnits, Wallet} from 'ethers'
import {DEV, GarbageCollectorConfig, sleepBetweenActions} from '../../config'
import {c, defaultSleep, RandomHelpers, retry} from '../utils/helpers'
import {ChainName, NotChainName, TokenlistResp} from '../utils/types'
import {Multicall, unwrap} from '../periphery/web3Client'
import {chains, networkNameToCoingeckoQueryString} from '../utils/constants'
import {checkConnection, getProvider, getTokenPrices} from '../periphery/utils'
import {OdosAggregator} from '../periphery/odosAggregator'
import {Sushiswap} from '../periphery/sushiswap'
import {readFileSync, writeFileSync} from 'fs'

class GarbageCollector extends GarbageCollectorConfig {
    signer: Wallet
    proxies: string[] | undefined
    tokenlists: {
        [key: ChainName | string]: {
            chainId: number
            address: string
            name: string
            symbol: string
            decimals: number
            logoURI: string
        }[]
    } = {}
    nonzeroTokens: {[key: ChainName | string]: {address: string; name: string; symbol: string; decimals: bigint; balance: bigint}[]} = {}
    constructor(signer: Wallet, proxies?: string[]) {
        super()
        this.signer = signer
        this.proxies = proxies

        this.tokensToIgnore = this.tokensToIgnore.map((elem) => elem.toLowerCase().trim())
        this.chainsToExclude = this.chainsToExclude.map((elem) => elem.toLowerCase().trim()) as (ChainName | NotChainName)[]
    }
    connect(signer: Wallet) {
        this.signer = signer
        this.nonzeroTokens = {}
    }
    async #fetchTokenList(networkName: ChainName) {
        if (!networkNameToCoingeckoQueryString[networkName]) return []
        if (this.tokenlists[networkName] != undefined) return this.tokenlists[networkName]
        try {
            let res: TokenlistResp = await retry(
                async () => {
                    let url = `https://tokens.coingecko.com/${networkNameToCoingeckoQueryString[networkName]}/all.json`
                    let resp = await fetch(url, {method: 'GET'})
                    let body = await resp.json()
                    return body
                },
                {maxRetryCount: 5, retryInterval: 5, needLog: false}
            )
            let tokens = res.tokens
            if (tokens.length > 0) {
                try {
                    writeFileSync(`src/utils/tokenlists/${networkName}.json`, JSON.stringify(tokens, null, 4))
                } catch (e: any) {
                    console.log(c.red(`could not save tokenlist for ${networkName}`))
                    console.log(e)
                }
            } else {
                try {
                    tokens = JSON.parse(readFileSync(`../utils/tokenlists/${networkName}.json`, 'utf-8'))
                } catch (e: any) {
                    console.log(c.red(`could not read tokenlist from ${networkName}, this chain will be skipped`))
                    tokens = []
                }
            }
            if (DEV) {
                console.log(`${networkName}: fetched tokenList with ${tokens.length} tokens`)
            }
            this.tokenlists[networkName] = tokens
            return res.tokens
        } catch (e: any) {
            try {
                return JSON.parse(readFileSync(`../utils/tokenlists/${networkName}.json`, 'utf-8'))
            } catch (e: any) {
                console.log(c.red(`could not read tokenlist from ${networkName}, this chain will be skipped`))
            }
            if (DEV) {
                console.log(e)
                console.log(c.red(`fetchTokenList ${networkName}: ERROR`))
            }
            return []
        }
    }
    async getNonZeroTokensAndSwap() {
        let networks = RandomHelpers.shuffleArray(Object.keys(chains))
        for (let i = 0; i < networks.length; i++) {
            let networkName = networks[i] as ChainName
            if (this.chainsToExclude.length > 0 && this.chainsToExclude[0].includes('!')) {
                if (!networkName.toLowerCase().includes(this.chainsToExclude[0].split('!')[1])) {
                    continue
                }
            }
            if (this.chainsToExclude.includes(networkName.toLowerCase() as ChainName | NotChainName)) {
                continue
            }
            let tokenlist = await this.#fetchTokenList(networkName)
            if (tokenlist.length == 0) {
                continue
            }
            await this.getNonZeroTokensForChain(networkName)
            await this.swapTokensToNativeForChain(networkName)
        }
    }
    // unused yet
    async getNonZeroTokens() {
        for (let i = 0; i < Object.keys(chains).length; i++) {
            let networkName = Object.keys(chains)[i] as ChainName
            if (this.chainsToExclude.length > 0 && this.chainsToExclude[0].includes('!')) {
                if (!networkName.toLowerCase().includes(this.chainsToExclude[0].split('!')[1])) {
                    continue
                }
            }
            if (this.chainsToExclude.includes(networkName.toLowerCase() as ChainName | NotChainName)) {
                continue
            }
            let tokenlist = await this.#fetchTokenList(networkName)
            if (tokenlist.length == 0) {
                continue
            }
            await this.getNonZeroTokensForChain(networkName)
        }
    }
    // unused yet
    async swapTokensToNative() {
        for (let i = 0; i < Object.keys(chains).length; i++) {
            let networkName = Object.keys(chains)[i] as ChainName
            if (this.chainsToExclude.length > 0 && this.chainsToExclude[0].includes('!')) {
                if (!networkName.includes(this.chainsToExclude[0].split('!')[1])) {
                    continue
                }
            }
            if (this.chainsToExclude.includes(networkName)) {
                continue
            }
            await this.swapTokensToNativeForChain(networkName)
        }
    }
    async getNonZeroTokensForChain(networkName: ChainName) {
        let nonzeroTokens = await Multicall.setNetwork(networkName).callBalance(
            this.signer.address,
            this.tokenlists[networkName].map((elem) => elem.address)
        )
        let nonzeroTokenData = await Multicall.getTokenInfo(nonzeroTokens.map((elem) => elem.token))
        let nonzeroTokenList: {address: string; name: string; symbol: string; decimals: bigint; balance: bigint}[] = []
        // could be done better lol
        for (let i = 0; i < nonzeroTokenData.length; i++) {
            nonzeroTokenList.push({
                address: nonzeroTokenData[i].address,
                name: nonzeroTokenData[i].name,
                symbol: nonzeroTokenData[i].symbol,
                decimals: nonzeroTokenData[i].decimals,
                balance: nonzeroTokens[i].balance
            })
        }
        let prices: {[key: string]: number} = {}
        if (nonzeroTokenData.length > 0) {
            prices = await getTokenPrices(
                networkName,
                nonzeroTokenData.map((elem) => elem.address)
            )
        }
        console.log(c.cyan.bold(networkName), c.yellow(`found ${nonzeroTokenList.length} nonzero tokens`))
        let networkValue = 0
        for (let nonzeroToken of nonzeroTokenList) {
            let nameOffset = 35 - nonzeroToken.name.length < 0 ? 0 : 35 - nonzeroToken.name.length
            let nameText = nonzeroToken.name + ' '.repeat(nameOffset)
            let symbolOffset = 8 - nonzeroToken.symbol.length < 0 ? 0 : 8 - nonzeroToken.symbol.length
            let symbolText = `(${c.yellow(nonzeroToken.symbol)}):${' '.repeat(symbolOffset)}`
            let amount =
                parseFloat(formatUnits(nonzeroToken.balance, nonzeroToken.decimals)) > 99_999
                    ? 'a lot'
                    : parseFloat(formatUnits(nonzeroToken.balance, nonzeroToken.decimals)).toFixed(1)
            let amountOffset = 7 - amount.length < 0 ? 0 : 7 - amount.length
            let amountText = amount + ' '.repeat(amountOffset)
            let price = (parseFloat(formatUnits(nonzeroToken.balance, nonzeroToken.decimals)) * (prices[nonzeroToken.address] ?? 0)).toFixed(2)
            let priceOffset = 8 - price.length < 0 ? 0 : 8 - price.length
            let priceText = ' '.repeat(priceOffset) + c.green(price)
            console.log(`   ${nameText} ${symbolText} ${amountText} ${priceText} USD`)
            networkValue += parseFloat(price)
        }
        let networkValueText = `network value: ${networkValue.toFixed(2)} USD`
        // 71 -- whole paste's length built above
        let networkValueOffset = 71 - networkValueText.length < 0 ? 0 : 71 - networkValueText.length
        console.log(c.magenta.bold(' '.repeat(networkValueOffset) + networkValueText))
        this.nonzeroTokens[networkName] = nonzeroTokenList
    }
    async swapTokensToNativeForChain(networkName: ChainName) {
        let shuffledTokens = RandomHelpers.shuffleArray(this.nonzeroTokens[networkName])
        for (let token of shuffledTokens) {
            let nativeToken = {
                address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
                name: chains[networkName].currency,
                symbol: chains[networkName].currency,
                decimals: 18n
            }
            if (this.tokensToIgnore.includes(token.address.toLowerCase())) {
                let symbolOffset = 8 - token.symbol.length < 0 ? 0 : 8 - token.symbol.length
                console.log(`${c.blue(token.symbol) + ' '.repeat(symbolOffset)} is ignored`)
                continue
            }
            if (token.address.toLowerCase() == chains[networkName].tokens.WNATIVE.address.toLowerCase()) {
                if (networkName == 'Celo') {
                    continue
                }
                // need to unwrap in this case, not swap
                try {
                    let unwrapHash = await unwrap(this.signer.connect(getProvider(networkName)), token.address, token.balance, {limit: 1, price: 1.1})
                    console.log(c.green(`unwrapped ${formatEther(token.balance)} ${token.symbol} ${chains[networkName].explorer + unwrapHash}`))
                } catch (e: any) {
                    console.log(c.red(`Unwrap failed. Reason: ${e?.message ?? 'undefined'}`))
                }
                continue
            }
            let proxy: string | undefined
            if (this.proxies != undefined) {
                if (this.proxies.length > 0) {
                    this.proxies = RandomHelpers.shuffleArray(this.proxies)
                    for (let testProxy of this.proxies) {
                        let isProxyGood = await checkConnection(testProxy)
                        if (isProxyGood) {
                            proxy = testProxy
                            break
                        }
                        await defaultSleep(0.1, false)
                    }
                    if (proxy == undefined) {
                        console.log(c.red('No valid proxy found, trying to go "as is"'))
                    }
                } else {
                    console.log(c.magenta.bold('Proxy not set, trying to go "as is"'))
                    proxy = undefined
                }
            } else {
                console.log(c.magenta.bold('Proxy not set, trying to go "as is"'))
                proxy = undefined
            }
            const odos = new OdosAggregator(this.signer.connect(getProvider(networkName)), networkName, proxy)
            let odosSuccess = await odos.swap(token, nativeToken, token.balance)
            let sushiSuccess
            if (!odosSuccess && this.trySushi) {
                let sushi = new Sushiswap(this.signer.connect(getProvider(networkName)), networkName)
                sushiSuccess = await sushi.swap(token, nativeToken, token.balance)
            }
            if (odosSuccess || sushiSuccess) {
                await defaultSleep(RandomHelpers.getRandomNumber(sleepBetweenActions))
            } else {
                await defaultSleep(1, false)
            }
        }
    }
}

export {GarbageCollector}