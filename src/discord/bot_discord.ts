/**
 * Discord Bot. It takes advantage of the functions defined in core.ts.
 */

import * as DiscordBot from "discord.js"
import { Core } from "../core/core"
import { DiscordConfig } from "./types_discord"
import { IGroupConfig } from "../core/types_core"

export class EnforcingDiscordBot extends DiscordBot.Client {
  readonly core: Core

  readonly discordConfig: DiscordConfig

  constructor(core: Core, config: DiscordConfig) {
    super()
    this.core = core
    this.discordConfig = config

    this.login(config.DISCORD_TOKEN)
  }

  /**
   * Starts listening to new messages.
   */
  start(): void {
    // Handles all messages and checks whether they're in the specified language
    this.on("message", async (msg) => {
      if (msg.author === this.user) {
        // prevents reacting to own messages
        return
      }

      if (msg.content === undefined) {
        console.log("Message doesn't contain text, returned. (msg.content === undefined)")
        return
      }

      if (!msg.guild) {
        console.log("Message was sent in a private chat, returned. (msg.channel instanceof DiscordBot.DMChannel)")
        msg.reply("Sorry, I work only in servers.")
        return
      }

      const exceptMatch = msg.content.match(/\/except (.+)/)
      const removeMatch = msg.content.match(/\/remove (.+)/)
      const showConfigMatch = msg.content.match(/\/config/)

      if (exceptMatch && exceptMatch[1]) {
        const match = exceptMatch[1]
        console.log(`matched except: ${match}`)
        this.handleExcept(msg, match)
      } else if (removeMatch && removeMatch[1]) {
        const match = removeMatch[1]
        console.log(`matched remove: ${match}`)
        this.handleRemove(msg, match)
      } else if (showConfigMatch) {
        console.log("Showing config")
        const groupConfig = await this.core.showGroupConfig(EnforcingDiscordBot.createDiscordServerId(msg.guild))
        this.handleShowConfig(msg, groupConfig)
      }

      const translationContext = await this.core.translateAndCheck(msg.content)

      if (!translationContext.translation) {
        console.log("translationContext.translation is null. That's probably an error. Returned.")
        return
      }

      if (!translationContext.isCorrectLang) {
        const permitted = await this.core.shouldBePermitted(
          msg.content,
          EnforcingDiscordBot.createDiscordServerId(msg.guild)
        )

        if (!permitted && translationContext.translation) {
          this.performAction(
            msg,
            translationContext.translation.detectedLangName,
            translationContext.requiredLangName,
            translationContext.translation.translatedText
          )
        }
      }
    })

    this.on("guildCreate", (guild) => {
      this.core.initNewGroup(EnforcingDiscordBot.createDiscordServerId(guild))
      if (guild.systemChannel) {
        guild.systemChannel.send(`Hello! Since now, you are only allowed to speak ${this.core.config.REQUIRED_LANG}.`)
        return
      }
      console.log("This server has no default channel. Sending to first available channel")
      let channel
      for (const c of guild.channels.cache) {
        if (c[1].type === "text") {
          channel = c[0]
          break
        }
      }
      channel.send(`Hello! Since now, you are only allowed to speak ${this.core.config.REQUIRED_LANG}.`)
    })

    console.log("Started Discord bot.")
  }

  /**
   * Returns true if the user is an admin or a creator, false otherwise.
   */
  static isAdminUser(guildMember: DiscordBot.GuildMember): boolean {
    return guildMember.hasPermission("MANAGE_MESSAGES") // users who manage messages can't be muted
  }

  /**
   * Performs an action on the user (whether to just remind him to use the
   * specified language, or ban him).
   */
  async performAction(
    msg: DiscordBot.Message,
    detectedLangName: string,
    requiredLangName: string,
    translatedText: string
  ): Promise<void> {
    if (!msg.member) {
      console.log("msg.member is undefined. Returned.")
      return
    }

    console.log(`Performing rebuke/mute/translate action on user ${msg.author.username}...`)
    let message = `Hey, don't speak ${detectedLangName}! We only use ${requiredLangName} here.`

    if (this.core.config.MUTE_PEOPLE && !EnforcingDiscordBot.isAdminUser(msg.member)) {
      this.mute(msg)
      message += `You've been muted for ${this.core.config.MUTE_TIMEOUT / 1000} seconds.`
    }

    if (this.core.config.BE_HELPFUL) {
      if (translatedText !== msg.content) {
        message += `BTW, we know you mean "${translatedText}"`
      } else {
        message += "BTW, we've no idea what you tried to say."
      }
    }

    msg.reply(message)
  }

  /**
   * Temporarily mutes the user for sending the inappropriate messages.
   * Mutes only if the user is not an admin.
   * @param {DiscordBot.Message} msg Discord Message object
   */
  async mute(msg: DiscordBot.Message): Promise<void> {
    console.log(`mute() function invoked for user ${msg.author.username}`)

    if (!msg.guild) {
      console.error("Something very weird has happened. Somehow, there doesn't appear to be a Discord server")
      return
    }

    msg.guild.channels.cache.forEach(async (channel) => {
      if (!msg.member) {
        console.log("Message author is no longer a server member. Returned")
        return
      }

      channel.overwritePermissions(
        [
          {
            id: msg.member,
            deny: "SEND_MESSAGES"
          }
        ],
        "Spoke wrong language"
      )
    })

    console.log(`Muting user ${msg.author.username} for ${this.core.config.MUTE_TIMEOUT / 1000} seconds.`)

    setTimeout(async () => {
      if (!msg.guild) {
        console.error("Something very weird has happened. Somehow, there doesn't appear to be a Discord server")
        return
      }

      msg.guild.channels.cache.forEach(async (channel) => {
        if (!msg.member) {
          console.log("Message author is no longer a server member. Returned")
          return
        }

        channel.overwritePermissions(
          [
            {
              id: msg.member,
              allow: "SEND_MESSAGES"
            }
          ],
          "Spoke wrong language - Timeout over"
        )
      })
      console.log(`Unmuted user ${msg.author.username}.`)
    }, this.core.config.MUTE_TIMEOUT)
  }

  /**
   * Handles adding words to the exception list
   */
  async handleExcept(msg: DiscordBot.Message, match: string): Promise<void> {
    if (!msg.member || !EnforcingDiscordBot.isAdminUser(msg.member)) {
      console.log("User is not an admin or has left the server. Returned.")
      msg.reply("Sorry, this is a admin-only feature.")
      return
    }

    if (!msg.guild) {
      console.error("Something very weird happened. A server-less message wasn't detected")
      return
    }

    const successful = await this.core.addException(match, EnforcingDiscordBot.createDiscordServerId(msg.guild))

    if (successful) {
      msg.reply(`Okay, "${match}" has been added to the exception list. `)
    } else {
      msg.reply(`An error occurred while adding the word ${match}`)
    }
  }

  /**
   * Handles removing words from the exception list
   */
  async handleRemove(msg: DiscordBot.Message, match: string): Promise<void> {
    if (!msg.member || !EnforcingDiscordBot.isAdminUser(msg.member)) {
      console.log("User is not an admin or has left the server. Returned.")
      msg.reply("Sorry, this is a admin-only feature.")
      return
    }

    if (!msg.guild) {
      console.error("Something very weird happened. A server-less message wasn't detected")
      return
    }

    const successful = await this.core.removeException(match, EnforcingDiscordBot.createDiscordServerId(msg.guild))

    if (successful) {
      msg.reply(`Okay, "${match}" has been removed from the exception list. `)
    } else {
      msg.reply(`An error occurred while removing the word ${match}`)
    }
  }

  /**
   * Handles showing the group config
   */
  async handleShowConfig(msg: DiscordBot.Message, groupConfig: IGroupConfig): Promise<void> {
    const message = `Current config for this group is: \nrequiredLang: ${groupConfig.requiredLang}\nmutePeople: ${groupConfig.mutePeople}\nbeHelpful: ${groupConfig.beHelpful}`

    await msg.reply(message)
  }

  static createDiscordServerId(guild: DiscordBot.Guild): string {
    return `DC_${guild.id}`
  }
}
